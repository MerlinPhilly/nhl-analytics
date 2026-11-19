"""Export DuckDB → compact JSON files the static site reads.

  python -m nhl.export --out _site/data

Tables are written column-oriented ({"cols": [...], "rows": [[...], ...]})
to keep files small.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import os
from collections import defaultdict

from . import db, trends

log = logging.getLogger("nhl.export")


def _clean(v):
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 4)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if hasattr(v, "item"):  # numpy scalar
        return _clean(v.item())
    return v


def table(con, sql: str, params=None) -> dict:
    cur = con.execute(sql, params or [])
    cols = [d[0] for d in cur.description]
    rows = [[_clean(v) for v in r] for r in cur.fetchall()]
    return {"cols": cols, "rows": rows}


def write(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), default=_clean)


SKATER_COLS = """game_id, game_date, season, game_type, team_abbrev, opp_abbrev, is_home,
    position, goals, assists, points, plus_minus, pim, sog, hits, blocks, giveaways,
    takeaways, shifts, faceoff_pct, toi_sec, ppg, ppp, shg, shp, gwg, otg, evg, evp,
    team_result, rest_days, team_gf, team_ga"""

GOALIE_COLS = """game_id, game_date, season, game_type, team_abbrev, opp_abbrev, is_home,
    started, decision, shots_against, saves, goals_against, ev_saves, ev_shots,
    pp_saves, pp_shots, sh_saves, sh_shots, toi_sec, team_result, rest_days"""

TEAM_COLS = """game_id, game_date, season, game_type, opp_abbrev, is_home, gf, ga,
    sog_for, sog_against, result, decided_in, pp_goals, pp_opps, pk_goals_against,
    pk_opps, faceoff_pct, hits, blocks, pim, giveaways, takeaways, rest_days, game_num"""

SKATER_AGG = """
WITH g AS (
  SELECT *, row_number() OVER (PARTITION BY player_id, season, game_type
                               ORDER BY game_date DESC, game_id DESC) AS rn
  FROM v_skater_games)
SELECT g.player_id, coalesce(any_value(p.full_name), any_value(g.name)) AS name,
       coalesce(any_value(p.position), mode(g.position)) AS pos,
       arg_max(g.team_abbrev, g.game_date) AS team,
       g.season, g.game_type,
       count(*) AS gp, sum(goals) AS g, sum(assists) AS a, sum(points) AS p,
       sum(sog) AS sog, sum(ppp) AS ppp, sum(shp) AS shp, sum(gwg) AS gwg,
       sum(plus_minus) AS pm, sum(pim) AS pim, sum(hits) AS hits, sum(blocks) AS blk,
       sum(toi_sec) AS toi,
       count(*) FILTER (rn <= 5) AS gp5, sum(points) FILTER (rn <= 5) AS p5,
       sum(goals) FILTER (rn <= 5) AS g5, sum(sog) FILTER (rn <= 5) AS sog5,
       count(*) FILTER (rn <= 10) AS gp10, sum(points) FILTER (rn <= 10) AS p10,
       sum(goals) FILTER (rn <= 10) AS g10, sum(sog) FILTER (rn <= 10) AS sog10,
       sum(toi_sec) FILTER (rn <= 10) AS toi10,
       count(*) FILTER (points > 0) AS pt_games, count(*) FILTER (points >= 2) AS multi,
       sum(giveaways) AS gv, sum(takeaways) AS tk,
       max(game_date) AS last_game
FROM g LEFT JOIN players p USING (player_id)
WHERE g.season = ?
GROUP BY g.player_id, g.season, g.game_type
ORDER BY p DESC
"""

GOALIE_AGG = """
WITH g AS (
  SELECT *, row_number() OVER (PARTITION BY player_id, season, game_type
                               ORDER BY game_date DESC, game_id DESC) AS rn
  FROM v_goalie_games)
SELECT g.player_id, coalesce(any_value(p.full_name), any_value(g.name)) AS name,
       arg_max(g.team_abbrev, g.game_date) AS team, g.season, g.game_type,
       count(*) AS gp, count(*) FILTER (started) AS gs,
       count(*) FILTER (decision = 'W') AS w, count(*) FILTER (decision = 'L') AS l,
       count(*) FILTER (decision IN ('O', 'OT', 'OTL')) AS otl,
       sum(shots_against) AS sa, sum(saves) AS sv, sum(goals_against) AS ga,
       sum(toi_sec) AS toi,
       count(*) FILTER (shots_against > 0 AND goals_against = 0 AND started) AS so,
       sum(shots_against) FILTER (rn <= 5) AS sa5, sum(saves) FILTER (rn <= 5) AS sv5,
       sum(shots_against) FILTER (rn <= 10) AS sa10, sum(saves) FILTER (rn <= 10) AS sv10,
       count(*) FILTER (rn <= 10) AS gp10,
       sum(ev_saves) AS ev_sv, sum(ev_shots) AS ev_sa, sum(pp_saves) AS pp_sv, sum(pp_shots) AS pp_sa,
       count(*) FILTER (started AND shots_against > 0 AND saves::DOUBLE / shots_against >= 0.9) AS qs,
       max(game_date) AS last_game
FROM g LEFT JOIN players p USING (player_id)
WHERE g.season = ?
GROUP BY g.player_id, g.season, g.game_type
ORDER BY gp DESC
"""

TEAM_AGG = """
WITH g AS (
  SELECT *, row_number() OVER (PARTITION BY team_abbrev, season, game_type
                               ORDER BY game_date DESC, game_id DESC) AS rn
  FROM v_team_games)
SELECT team_abbrev AS team, season, game_type, count(*) AS gp,
       count(*) FILTER (result = 'W') AS w, count(*) FILTER (result = 'L') AS l,
       count(*) FILTER (result = 'OTL') AS otl,
       2 * count(*) FILTER (result = 'W') + count(*) FILTER (result = 'OTL') AS pts,
       sum(gf) AS gf, sum(ga) AS ga, sum(sog_for) AS sf, sum(sog_against) AS sa,
       sum(pp_goals) AS ppg, sum(pp_opps) AS ppo,
       sum(pk_goals_against) AS pkga, sum(pk_opps) AS pko,
       avg(faceoff_pct) AS fo,
       count(*) FILTER (rn <= 10 AND result = 'W') AS w10,
       count(*) FILTER (rn <= 10 AND result = 'L') AS l10,
       count(*) FILTER (rn <= 10 AND result = 'OTL') AS otl10,
       sum(gf) FILTER (rn <= 10) AS gf10, sum(ga) FILTER (rn <= 10) AS ga10,
       count(*) FILTER (is_home AND result = 'W') AS hw, count(*) FILTER (is_home) AS hgp,
       count(*) FILTER (NOT is_home AND result = 'W') AS aw, count(*) FILTER (NOT is_home) AS agp,
       arg_max(result, game_date) AS last_result
FROM g WHERE season = ?
GROUP BY team_abbrev, season, game_type
ORDER BY pts DESC
"""


def export(con, out: str) -> dict:
    seasons = [r[0] for r in con.execute("SELECT DISTINCT season FROM games ORDER BY season").fetchall()]
    counts = {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
              for t in ("games", "skater_games", "goalie_games", "players")}
    last_game = con.execute("SELECT max(game_date) FROM games").fetchone()[0]

    # --- teams
    team_rows = con.execute("""
        SELECT a.abbrev, t.name, t.common_name, t.conference, t.division,
               a.abbrev IN (SELECT abbrev FROM teams) AS current
        FROM (SELECT DISTINCT team_abbrev AS abbrev FROM team_games) a
        LEFT JOIN teams t USING (abbrev) ORDER BY a.abbrev""").fetchall()
    write(f"{out}/teams.json", [dict(zip(
        ["abbrev", "name", "common_name", "conference", "division", "current"], r)) for r in team_rows])

    # --- player index
    idx = table(con, """
        WITH all_games AS (
            SELECT player_id, season, team_abbrev, game_date, name, position FROM skater_games
            UNION ALL
            SELECT player_id, season, team_abbrev, game_date, name, 'G' FROM goalie_games)
        SELECT a.player_id AS id, coalesce(any_value(p.full_name), arg_max(a.name, a.game_date)) AS name,
               coalesce(any_value(p.position), mode(a.position)) AS pos,
               arg_max(a.team_abbrev, a.game_date) AS team,
               list(DISTINCT a.season ORDER BY a.season) AS seasons,
               count(*) AS gp, max(a.game_date) AS last_game
        FROM all_games a LEFT JOIN players p USING (player_id)
        GROUP BY a.player_id ORDER BY name""")
    write(f"{out}/players.json", idx)

    # --- per player files
    bios = {r[0]: r for r in con.execute(
        "SELECT player_id, full_name, position, shoots, birth_date, birth_country, height_in, "
        "weight_lb, sweater, current_team, is_active FROM players").fetchall()}
    bio_cols = ["id", "name", "pos", "shoots", "birth_date", "birth_country", "height_in",
                "weight_lb", "sweater", "current_team", "is_active"]

    sk = table(con, f"SELECT player_id, {SKATER_COLS} FROM v_skater_games ORDER BY player_id, game_date, game_id")
    by_player: dict[int, list] = defaultdict(list)
    for r in sk["rows"]:
        by_player[r[0]].append(r[1:])
    gk = table(con, f"SELECT player_id, {GOALIE_COLS} FROM v_goalie_games ORDER BY player_id, game_date, game_id")
    by_goalie: dict[int, list] = defaultdict(list)
    for r in gk["rows"]:
        by_goalie[r[0]].append(r[1:])

    for pid, row in [(r[0], r) for r in idx["rows"]]:
        bio = dict(zip(bio_cols, [_clean(v) for v in bios[pid]])) if pid in bios else \
            {"id": pid, "name": row[1], "pos": row[2], "current_team": row[3]}
        doc = {"bio": bio}
        if pid in by_player:
            doc["skater"] = {"cols": sk["cols"][1:], "rows": by_player[pid]}
        if pid in by_goalie:
            doc["goalie"] = {"cols": gk["cols"][1:], "rows": by_goalie[pid]}
        write(f"{out}/players/{pid}.json", doc)

    # --- per team files
    for (abbrev, *_rest) in team_rows:
        doc = {
            "games": table(con, f"SELECT {TEAM_COLS} FROM v_team_games WHERE team_abbrev = ? "
                                "ORDER BY game_date, game_id", [abbrev]),
            "skaters": table(con, f"""
                SELECT s.player_id AS id, coalesce(any_value(p.full_name), any_value(s.name)) AS name,
                       coalesce(any_value(p.position), mode(s.position)) AS pos, season, game_type,
                       count(*) AS gp, sum(goals) AS g, sum(assists) AS a, sum(points) AS p,
                       sum(sog) AS sog, sum(ppp) AS ppp, sum(plus_minus) AS pm, sum(hits) AS hits,
                       sum(blocks) AS blk, sum(toi_sec) AS toi
                FROM v_skater_games s LEFT JOIN players p USING (player_id)
                WHERE team_abbrev = ? GROUP BY s.player_id, season, game_type ORDER BY p DESC""", [abbrev]),
            "goalies": table(con, f"""
                SELECT g.player_id AS id, coalesce(any_value(p.full_name), any_value(g.name)) AS name,
                       season, game_type, count(*) AS gp, count(*) FILTER (started) AS gs,
                       count(*) FILTER (decision = 'W') AS w, count(*) FILTER (decision = 'L') AS l,
                       count(*) FILTER (decision IN ('O','OT','OTL')) AS otl,
                       sum(shots_against) AS sa, sum(saves) AS sv, sum(goals_against) AS ga,
                       sum(toi_sec) AS toi
                FROM v_goalie_games g LEFT JOIN players p USING (player_id)
                WHERE team_abbrev = ? GROUP BY g.player_id, season, game_type ORDER BY gp DESC""", [abbrev]),
        }
        write(f"{out}/teams/{abbrev}.json", doc)

    # --- league-wide season files (screener, percentiles, standings)
    for season in seasons:
        write(f"{out}/league/{season}.json", {
            "skaters": table(con, SKATER_AGG, [season]),
            "goalies": table(con, GOALIE_AGG, [season]),
            "teams": table(con, TEAM_AGG, [season]),
            "form": trends.season_form(con, season),
        })
        write(f"{out}/games/{season}.json", table(con, """
            SELECT game_id, game_date, game_type, away_abbrev, away_score, home_abbrev, home_score,
                   last_period_type, away_sog, home_sog, venue
            FROM games WHERE season = ? ORDER BY game_date DESC, game_id DESC""", [season]))

    # --- per-game box scores
    tg = con.execute(f"SELECT game_id, team_abbrev, {TEAM_COLS} FROM v_team_games").fetchall()
    tg_cols = ["team_abbrev"] + [c.strip() for c in TEAM_COLS.replace("\n", " ").split(",")]
    by_game_team = defaultdict(list)
    for r in tg:
        by_game_team[r[0]].append(dict(zip(tg_cols, [_clean(v) for v in r[1:]])))
    sk_box = con.execute("""
        SELECT s.game_id, s.player_id, coalesce(p.full_name, s.name), s.team_abbrev, s.position,
               s.goals, s.assists, s.points, s.plus_minus, s.pim, s.sog, s.hits, s.blocks,
               s.toi_sec, s.ppp, s.faceoff_pct
        FROM v_skater_games s LEFT JOIN players p USING (player_id)
        ORDER BY s.game_id, s.team_abbrev, s.points DESC, s.toi_sec DESC""").fetchall()
    sk_box_cols = ["id", "name", "team", "pos", "g", "a", "p", "pm", "pim", "sog", "hits", "blk",
                   "toi", "ppp", "fo"]
    gk_box = con.execute("""
        SELECT g.game_id, g.player_id, coalesce(p.full_name, g.name), g.team_abbrev, g.decision,
               g.shots_against, g.saves, g.goals_against, g.toi_sec, g.started
        FROM goalie_games g LEFT JOIN players p USING (player_id)
        ORDER BY g.game_id, g.team_abbrev, g.toi_sec DESC""").fetchall()
    gk_box_cols = ["id", "name", "team", "dec", "sa", "sv", "ga", "toi", "started"]
    box_sk, box_gk = defaultdict(list), defaultdict(list)
    for r in sk_box:
        box_sk[r[0]].append([_clean(v) for v in r[1:]])
    for r in gk_box:
        box_gk[r[0]].append([_clean(v) for v in r[1:]])
    for (gid, season, gtype, gdate, venue, home, away, hs, as_, lpt) in con.execute(
            "SELECT game_id, season, game_type, game_date, venue, home_abbrev, away_abbrev, "
            "home_score, away_score, last_period_type FROM games").fetchall():
        write(f"{out}/box/{gid}.json", {
            "game": {"id": gid, "season": season, "type": gtype, "date": _clean(gdate),
                     "venue": venue, "home": home, "away": away, "home_score": hs,
                     "away_score": as_, "ended_in": lpt},
            "teams": by_game_team.get(gid, []),
            "skaters": {"cols": sk_box_cols, "rows": box_sk.get(gid, [])},
            "goalies": {"cols": gk_box_cols, "rows": box_gk.get(gid, [])},
        })

    meta = {"updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "last_game": _clean(last_game), "seasons": seasons,
            "current_season": seasons[-1] if seasons else None, "counts": counts}
    write(f"{out}/meta.json", meta)
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(prog="nhl.export")
    ap.add_argument("--db", default=None)
    ap.add_argument("--out", default="_site/data")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    con = db.connect(args.db)
    meta = export(con, args.out)
    log.info("exported: %s", meta)


if __name__ == "__main__":
    main()
