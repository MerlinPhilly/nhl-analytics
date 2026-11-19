"""End-to-end test against the mock NHL API.  Run:  python -m pytest tests -q"""
import json
import os
import socket
import sys
import threading
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import mock_nhl  # noqa: E402


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    league = mock_nhl.League()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = ThreadingHTTPServer(("127.0.0.1", port), mock_nhl.make_handler(league))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    tmp = tmp_path_factory.mktemp("nhl")
    os.environ.update(NHL_WEB_BASE=f"http://127.0.0.1:{port}/v1",
                      NHL_STATS_BASE=f"http://127.0.0.1:{port}/stats/rest/en", NHL_MAX_RPS="0")
    import importlib
    import nhl.api
    importlib.reload(nhl.api)
    import nhl.ingest
    importlib.reload(nhl.ingest)
    yield league, tmp
    srv.shutdown()


def test_backfill_daily_export(env):
    league, tmp = env
    from nhl import db, export, ingest
    dbp = str(tmp / "t.duckdb")
    ingest.main(["--db", dbp, "backfill", "--seasons", "20252026,20262027"])
    ingest.main(["--db", dbp, "daily"])
    con = db.connect(dbp)
    n_games = con.execute("SELECT count(*) FROM games").fetchone()[0]
    assert n_games == len(league.games)
    # every team row's goals = its skaters' goals (+1 for a shootout winner)
    bad = con.execute("""
        SELECT count(*) FROM team_games t
        JOIN (SELECT game_id, team_abbrev, sum(goals) g FROM skater_games GROUP BY ALL) s USING (game_id, team_abbrev)
        JOIN games USING (game_id)
        WHERE t.gf - s.g NOT IN (0, CASE WHEN last_period_type = 'SO' THEN 1 ELSE 0 END)""").fetchone()[0]
    assert bad == 0
    # each game has exactly one W
    assert con.execute("SELECT count(*) FROM (SELECT game_id FROM team_games GROUP BY 1 "
                       "HAVING count(*) FILTER (result = 'W') <> 1)").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM skater_extra").fetchone()[0] > 0
    out = tmp / "site"
    meta = export.export(con, str(out))
    assert meta["counts"]["games"] == n_games
    pl = json.load(open(out / "players.json"))
    assert len(pl["rows"]) == con.execute("SELECT count(*) FROM players").fetchone()[0]
    lg = json.load(open(out / "league" / "20262027.json"))
    form = lg["form"]
    assert form["skaters"] and form["teams"] and form["goalies"]
    statuses = [v["status"] for v in form["skaters"].values()]
    assert set(statuses) <= {"hot", "warming", "steady", "cooling", "cold"}
    # random mock league: most players should read as steady, extremes should be rare
    assert statuses.count("steady") / len(statuses) > 0.5
    assert (statuses.count("hot") + statuses.count("cold")) / len(statuses) < 0.15
    some = pl["rows"][0][0]
    assert (out / "players" / f"{some}.json").exists()
