"""Load NHL data into DuckDB.

  python -m nhl.ingest backfill --seasons 20212022,20222023,...   # one-time history load
  python -m nhl.ingest daily                                      # nightly update
  python -m nhl.ingest season --season 20262027                   # re-pull one season
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import db, parse
from .api import NHLClient, NotFound

log = logging.getLogger("nhl.ingest")

DEFAULT_SEASONS = ["20212022", "20222023", "20232024", "20242025", "20252026", "20262027"]
WORKERS = 6


def season_window(season: str) -> tuple[dt.date, dt.date]:
    start_year, end_year = int(season[:4]), int(season[4:])
    start = dt.date(start_year, 9, 20)
    end = min(dt.date(end_year, 7, 5), dt.date.today())
    return start, end


def scan_schedule(client: NHLClient, start: dt.date, end: dt.date) -> list[dict]:
    """Walk the weekly schedule endpoint from start to end."""
    games: dict[int, dict] = {}
    day = start
    while day <= end:
        week = client.schedule_week(day.isoformat())
        for g in parse.schedule_games(week):
            gd = dt.date.fromisoformat(g["game_date"])
            if start <= gd <= end:
                games[g["game_id"]] = g
        nxt = week.get("nextStartDate")
        new_day = dt.date.fromisoformat(nxt) if nxt else day + dt.timedelta(days=7)
        day = new_day if new_day > day else day + dt.timedelta(days=7)
    return sorted(games.values(), key=lambda g: (g["game_date"], g["game_id"]))


def fetch_game(client: NHLClient, game_id: int) -> dict:
    box = client.boxscore(game_id)
    try:
        rail = client.right_rail(game_id)
    except (NotFound, RuntimeError) as e:  # team stats are nice-to-have
        log.warning("right-rail missing for %s: %s", game_id, e)
        rail = None
    return parse.parse_boxscore(box, rail)


def load_games(con, client: NHLClient, game_ids: list[int]) -> int:
    if not game_ids:
        return 0
    done = 0
    batch: list[dict] = []

    def flush():
        tables = {"games": [], "team_games": [], "skater_games": [], "goalie_games": []}
        for p in batch:
            tables["games"].append(p["game"])
            for t in ("team_games", "skater_games", "goalie_games"):
                tables[t].extend(p[t])
        con.execute("BEGIN")
        for t, rows in tables.items():
            db.upsert(con, t, rows)
        con.execute("COMMIT")
        batch.clear()

    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(fetch_game, client, gid): gid for gid in game_ids}
        for f in as_completed(futures):
            gid = futures[f]
            try:
                batch.append(f.result())
            except Exception as e:  # keep going; a rerun picks up gaps
                log.error("game %s failed: %s", gid, e)
                continue
            done += 1
            if len(batch) >= 100:
                flush()
                log.info("  %d / %d games loaded", done, len(game_ids))
    if batch:
        flush()
    return done


def load_extras(con, client: NHLClient, cayenne: str) -> int:
    try:
        rows = client.skater_game_rows(cayenne)
    except Exception as e:
        log.warning("stats API enrichment failed (%s): %s", cayenne, e)
        return 0
    parsed = [parse.parse_skater_summary_row(r) for r in rows if r.get("gameId")]
    return db.upsert(con, "skater_extra", parsed)


def load_players(con, client: NHLClient, refresh_current: bool = False) -> int:
    missing = [r[0] for r in con.execute("""
        SELECT DISTINCT player_id FROM (
            SELECT player_id FROM skater_games UNION SELECT player_id FROM goalie_games)
        WHERE player_id NOT IN (SELECT player_id FROM players)""").fetchall()]
    if refresh_current:
        # Re-pull a rotating 1/7 of this season's players so team changes show up.
        wd = dt.date.today().weekday()
        missing += [r[0] for r in con.execute("""
            SELECT DISTINCT player_id FROM skater_games
            WHERE season = (SELECT max(season) FROM games) AND player_id % 7 = ?
            UNION SELECT DISTINCT player_id FROM goalie_games
            WHERE season = (SELECT max(season) FROM games) AND player_id % 7 = ?""",
            [wd, wd]).fetchall()]
    ids = sorted(set(missing))
    if not ids:
        return 0
    log.info("fetching %d player bios", len(ids))
    rows = []
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(client.player_landing, pid): pid for pid in ids}
        for f in as_completed(futures):
            try:
                rows.append(parse.parse_player(f.result()))
            except Exception as e:
                log.warning("player %s failed: %s", futures[f], e)
    return db.upsert(con, "players", rows)


def load_teams(con, client: NHLClient) -> int:
    try:
        teams = parse.parse_teams(client.standings("now"))
    except Exception as e:
        log.warning("standings failed: %s", e)
        return 0
    return db.upsert(con, "teams", [t for t in teams if t["abbrev"]])


# ---------------------------------------------------------------- commands
def cmd_backfill(con, client, seasons: list[str], force: bool = False) -> None:
    load_teams(con, client)
    for season in seasons:
        start, end = season_window(season)
        if start > dt.date.today():
            continue
        log.info("season %s: scanning schedule %s → %s", season, start, end)
        games = [g for g in scan_schedule(client, start, end) if g["is_final"]]
        have = {r[0] for r in con.execute(
            "SELECT game_id FROM games WHERE season = ?", [int(season)]).fetchall()}
        todo = [g["game_id"] for g in games if force or g["game_id"] not in have]
        log.info("season %s: %d final games, %d to load", season, len(games), len(todo))
        n = load_games(con, client, todo)
        for gt in (2, 3):
            load_extras(con, client, f"seasonId={season} and gameTypeId={gt}")
        db.log_run(con, "backfill", f"{season}: {n} games")
    n = load_players(con, client)
    log.info("player bios loaded: %d", n)


def cmd_daily(con, client, days: int = 3) -> None:
    """Pick up last night's games, re-pull the last few days for stat corrections."""
    load_teams(con, client)
    today = dt.date.today()
    last = con.execute("SELECT max(game_date) FROM games").fetchone()[0]
    start = (last - dt.timedelta(days=days)) if last else today - dt.timedelta(days=days)
    start = min(start, today - dt.timedelta(days=days))
    games = [g for g in scan_schedule(client, start, today) if g["is_final"]]
    n = load_games(con, client, [g["game_id"] for g in games])
    seasons = sorted({g["season"] for g in games})
    for season in seasons:
        for gt in (2, 3):
            load_extras(con, client,
                        f'seasonId={season} and gameTypeId={gt} and gameDate>="{start.isoformat()}"')
    p = load_players(con, client, refresh_current=True)
    db.log_run(con, "daily", f"{start}→{today}: {n} games, {p} players")
    log.info("daily: %d games (%s → %s), %d player bios", n, start, today, p)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="nhl.ingest")
    ap.add_argument("--db", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backfill")
    b.add_argument("--seasons", default=",".join(DEFAULT_SEASONS))
    b.add_argument("--force", action="store_true", help="re-pull games already loaded")
    d = sub.add_parser("daily")
    d.add_argument("--days", type=int, default=3)
    s = sub.add_parser("season")
    s.add_argument("--season", required=True)
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    con = db.connect(args.db)
    client = NHLClient()
    if args.cmd == "backfill":
        cmd_backfill(con, client, [s.strip() for s in args.seasons.split(",") if s.strip()], args.force)
    elif args.cmd == "daily":
        cmd_daily(con, client, args.days)
    elif args.cmd == "season":
        cmd_backfill(con, client, [args.season], force=True)
    con.execute("CHECKPOINT")
    con.close()


if __name__ == "__main__":
    main()
