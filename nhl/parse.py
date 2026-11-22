"""Turn raw NHL API JSON into flat rows.

The NHL changes field names from time to time, so every lookup here is
defensive: missing fields become None instead of crashing the pipeline.
"""
from __future__ import annotations

from typing import Any

FINAL_STATES = {"OFF", "FINAL"}
GAME_TYPES = {2: "R", 3: "P"}  # regular season, playoffs (preseason/all-star ignored)


def txt(v: Any) -> Any:
    """NHL text fields look like {"default": "Devils", "fr": ...}."""
    if isinstance(v, dict):
        return v.get("default")
    return v


def first(d: dict, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return default


def toi_seconds(v: Any) -> int | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return int(v)
    try:
        parts = [int(p) for p in str(v).split(":")]
    except ValueError:
        return None
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return None


def frac(v: Any) -> tuple[int | None, int | None]:
    """'23/25' -> (23, 25)."""
    if not isinstance(v, str) or "/" not in v:
        return None, None
    a, b = v.split("/", 1)
    try:
        return int(a), int(b)
    except ValueError:
        return None, None


# ---------------------------------------------------------------- schedule
def schedule_games(week: dict) -> list[dict]:
    out = []
    for day in week.get("gameWeek", []) or []:
        for g in day.get("games", []) or []:
            gt = g.get("gameType")
            if gt not in GAME_TYPES:
                continue
            out.append({
                "game_id": g["id"],
                "season": g.get("season"),
                "game_type": GAME_TYPES[gt],
                "game_date": day.get("date") or (g.get("gameDate")),
                "game_state": g.get("gameState"),
                "start_utc": g.get("startTimeUTC"),
                "is_final": g.get("gameState") in FINAL_STATES,
                "home_abbrev": first(g.get("homeTeam", {}), "abbrev"),
                "away_abbrev": first(g.get("awayTeam", {}), "abbrev"),
            })
    return out


# ---------------------------------------------------------------- box score
def _team_stats_from(source: dict) -> dict[str, dict]:
    """Return {'home': {...}, 'away': {...}} from a teamGameStats list."""
    stats = source.get("teamGameStats")
    if stats is None:
        stats = (source.get("summary") or {}).get("teamGameStats")
    out = {"home": {}, "away": {}}
    for s in stats or []:
        cat = s.get("category")
        out["home"][cat] = s.get("homeValue")
        out["away"][cat] = s.get("awayValue")
    return out


def _player_groups(box: dict) -> dict:
    pbg = box.get("playerByGameStats")
    if pbg is None:
        pbg = (box.get("boxscore") or {}).get("playerByGameStats", {})
    return pbg or {}


def parse_boxscore(box: dict, right_rail: dict | None = None) -> dict:
    """Return dict with keys game, team_games, skater_games, goalie_games."""
    gid = box["id"]
    season = box.get("season")
    gtype = GAME_TYPES.get(box.get("gameType"), "?")
    gdate = box.get("gameDate")
    home, away = box.get("homeTeam", {}), box.get("awayTeam", {})
    last_period = first(box.get("gameOutcome") or {}, "lastPeriodType") or \
        first(box.get("periodDescriptor") or {}, "periodType")

    game = {
        "game_id": gid, "season": season, "game_type": gtype, "game_date": gdate,
        "start_utc": box.get("startTimeUTC"), "venue": txt(box.get("venue")),
        "home_abbrev": home.get("abbrev"), "away_abbrev": away.get("abbrev"),
        "home_score": home.get("score"), "away_score": away.get("score"),
        "home_sog": first(home, "sog", "shotsOnGoal"), "away_sog": first(away, "sog", "shotsOnGoal"),
        "last_period_type": last_period, "game_state": box.get("gameState"),
    }

    ts = _team_stats_from(right_rail or {})
    if not ts["home"]:
        ts = _team_stats_from(box)

    groups = _player_groups(box)
    skaters, goalies = [], []
    team_agg = {"home": {}, "away": {}}
    for side, team, opp in (("home", home, away), ("away", away, home)):
        g = groups.get(f"{side}Team", {}) or {}
        agg = team_agg[side]
        for pos_key in ("forwards", "defense"):
            for p in g.get(pos_key, []) or []:
                row = {
                    "game_id": gid, "player_id": p.get("playerId"),
                    "team_abbrev": team.get("abbrev"), "opp_abbrev": opp.get("abbrev"),
                    "is_home": side == "home", "season": season, "game_type": gtype,
                    "game_date": gdate, "name": txt(p.get("name")),
                    "position": p.get("position"), "sweater": p.get("sweaterNumber"),
                    "goals": first(p, "goals", default=0),
                    "assists": first(p, "assists", default=0),
                    "points": first(p, "points"),
                    "plus_minus": first(p, "plusMinus", default=0),
                    "pim": first(p, "pim", "penaltyMinutes", default=0),
                    "hits": first(p, "hits", default=0),
                    "sog": first(p, "sog", "shots", default=0),
                    "blocks": first(p, "blockedShots", "blocks", default=0),
                    "giveaways": first(p, "giveaways", default=0),
                    "takeaways": first(p, "takeaways", default=0),
                    "shifts": first(p, "shifts"),
                    "ppg": first(p, "powerPlayGoals"),
                    "faceoff_pct": first(p, "faceoffWinningPctg"),
                    "toi_sec": toi_seconds(p.get("toi")),
                }
                if row["points"] is None:
                    row["points"] = (row["goals"] or 0) + (row["assists"] or 0)
                skaters.append(row)
                for k in ("hits", "blocks", "pim", "giveaways", "takeaways"):
                    agg[k] = agg.get(k, 0) + (row[k] or 0)
        for p in g.get("goalies", []) or []:
            sa_sv = frac(p.get("saveShotsAgainst"))
            ev = frac(p.get("evenStrengthShotsAgainst"))
            pp = frac(p.get("powerPlayShotsAgainst"))
            sh = frac(p.get("shorthandedShotsAgainst"))
            shots_against = first(p, "shotsAgainst", default=sa_sv[1])
            saves = first(p, "saves", default=sa_sv[0])
            toi = toi_seconds(p.get("toi"))
            if not toi and not shots_against:
                continue  # dressed but did not play
            goalies.append({
                "game_id": gid, "player_id": p.get("playerId"),
                "team_abbrev": team.get("abbrev"), "opp_abbrev": opp.get("abbrev"),
                "is_home": side == "home", "season": season, "game_type": gtype,
                "game_date": gdate, "name": txt(p.get("name")),
                "sweater": p.get("sweaterNumber"),
                "started": bool(p.get("starter")), "decision": p.get("decision"),
                "shots_against": shots_against, "saves": saves,
                "goals_against": first(p, "goalsAgainst"),
                "ev_saves": ev[0], "ev_shots": ev[1],
                "pp_saves": pp[0], "pp_shots": pp[1],
                "sh_saves": sh[0], "sh_shots": sh[1],
                "pim": first(p, "pim", default=0), "toi_sec": toi,
            })

    team_games = []
    for side, team, opp in (("home", home, away), ("away", away, home)):
        other = "away" if side == "home" else "home"
        gf, ga = team.get("score"), opp.get("score")
        if gf is None or ga is None:
            result = None
        elif gf > ga:
            result = "W"
        elif gtype == "R" and last_period in ("OT", "SO"):
            result = "OTL"
        else:
            result = "L"
        s, o = ts[side], ts[other]
        ppg, ppo = frac(s.get("powerPlay"))
        opp_ppg, opp_ppo = frac(o.get("powerPlay"))
        fo = s.get("faceoffWinningPctg")
        agg = team_agg[side]
        team_games.append({
            "game_id": gid, "team_abbrev": team.get("abbrev"), "opp_abbrev": opp.get("abbrev"),
            "is_home": side == "home", "season": season, "game_type": gtype, "game_date": gdate,
            "gf": gf, "ga": ga,
            "sog_for": first(team, "sog", default=s.get("sog")),
            "sog_against": first(opp, "sog", default=o.get("sog")),
            "result": result, "decided_in": last_period,
            "pp_goals": ppg, "pp_opps": ppo,
            "pk_goals_against": opp_ppg, "pk_opps": opp_ppo,
            "faceoff_pct": float(fo) if isinstance(fo, (int, float)) else None,
            "hits": s.get("hits", agg.get("hits")),
            "blocks": s.get("blockedShots", agg.get("blocks")),
            "pim": s.get("pim", agg.get("pim")),
            "giveaways": s.get("giveaways", agg.get("giveaways")),
            "takeaways": s.get("takeaways", agg.get("takeaways")),
        })

    return {"game": game, "team_games": team_games,
            "skater_games": skaters, "goalie_games": goalies}


# ---------------------------------------------------------------- stats API
def parse_skater_summary_row(r: dict) -> dict:
    """Extra per-game fields the box score lacks (PP/SH points, GWG...)."""
    return {
        "game_id": r.get("gameId"), "player_id": r.get("playerId"),
        "ppp": r.get("ppPoints"), "ppg2": r.get("ppGoals"),
        "shg": r.get("shGoals"), "shp": r.get("shPoints"),
        "gwg": r.get("gameWinningGoals"), "otg": r.get("otGoals"),
        "evg": r.get("evGoals"), "evp": r.get("evPoints"),
    }


# ---------------------------------------------------------------- players
def parse_player(d: dict) -> dict:
    first_n, last_n = txt(d.get("firstName")), txt(d.get("lastName"))
    return {
        "player_id": d.get("playerId"),
        "first_name": first_n, "last_name": last_n,
        "full_name": " ".join(x for x in (first_n, last_n) if x),
        "position": d.get("position"), "shoots": d.get("shootsCatches"),
        "birth_date": d.get("birthDate"), "birth_country": d.get("birthCountry"),
        "height_in": d.get("heightInInches"), "weight_lb": d.get("weightInPounds"),
        "sweater": d.get("sweaterNumber"),
        "current_team": d.get("currentTeamAbbrev"), "is_active": d.get("isActive"),
    }


def parse_career(d: dict) -> list[dict]:
    """NHL games played per team across a player's whole career (seasonTotals)."""
    pid = d.get("playerId")
    teams: dict[str, dict] = {}
    for st in d.get("seasonTotals") or []:
        if st.get("leagueAbbrev") != "NHL" or st.get("gameTypeId") not in (2, 3):
            continue
        name = txt(st.get("teamName"))
        season = st.get("season")
        if not name or not isinstance(season, int):
            continue
        t = teams.setdefault(name, {"gp": 0, "first": season, "last": season})
        t["gp"] += st.get("gamesPlayed") or 0
        t["first"], t["last"] = min(t["first"], season), max(t["last"], season)
    return [{"player_id": pid, "team_name": k, "gp": v["gp"], "first_season": v["first"],
             "last_season": v["last"]} for k, v in teams.items()]


# ---------------------------------------------------------------- standings
def parse_teams(standings: dict) -> list[dict]:
    out = []
    for s in standings.get("standings", []) or []:
        out.append({
            "abbrev": txt(s.get("teamAbbrev")),
            "name": txt(s.get("teamName")),
            "common_name": txt(s.get("teamCommonName")),
            "place": txt(s.get("placeName")),
            "conference": s.get("conferenceName"),
            "division": s.get("divisionName"),
        })
    return out
