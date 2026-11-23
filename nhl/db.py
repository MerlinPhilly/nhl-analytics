"""DuckDB storage: schema, upserts and analysis views."""
from __future__ import annotations

import os

import duckdb
import pandas as pd

DB_PATH = os.environ.get("NHL_DB", "data/nhl.duckdb")

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    game_id BIGINT PRIMARY KEY, season INTEGER, game_type VARCHAR, game_date DATE,
    start_utc VARCHAR, venue VARCHAR, home_abbrev VARCHAR, away_abbrev VARCHAR,
    home_score INTEGER, away_score INTEGER, home_sog INTEGER, away_sog INTEGER,
    last_period_type VARCHAR, game_state VARCHAR,
    ingested_at TIMESTAMP DEFAULT current_timestamp
);
CREATE TABLE IF NOT EXISTS team_games (
    game_id BIGINT, team_abbrev VARCHAR, opp_abbrev VARCHAR, is_home BOOLEAN,
    season INTEGER, game_type VARCHAR, game_date DATE,
    gf INTEGER, ga INTEGER, sog_for INTEGER, sog_against INTEGER,
    result VARCHAR, decided_in VARCHAR,
    pp_goals INTEGER, pp_opps INTEGER, pk_goals_against INTEGER, pk_opps INTEGER,
    faceoff_pct DOUBLE, hits INTEGER, blocks INTEGER, pim INTEGER,
    giveaways INTEGER, takeaways INTEGER,
    PRIMARY KEY (game_id, team_abbrev)
);
CREATE TABLE IF NOT EXISTS skater_games (
    game_id BIGINT, player_id BIGINT, team_abbrev VARCHAR, opp_abbrev VARCHAR,
    is_home BOOLEAN, season INTEGER, game_type VARCHAR, game_date DATE,
    name VARCHAR, position VARCHAR, sweater INTEGER,
    goals INTEGER, assists INTEGER, points INTEGER, plus_minus INTEGER, pim INTEGER,
    hits INTEGER, sog INTEGER, blocks INTEGER, giveaways INTEGER, takeaways INTEGER,
    shifts INTEGER, ppg INTEGER, faceoff_pct DOUBLE, toi_sec INTEGER,
    PRIMARY KEY (game_id, player_id)
);
CREATE TABLE IF NOT EXISTS skater_extra (
    game_id BIGINT, player_id BIGINT,
    ppp INTEGER, ppg2 INTEGER, shg INTEGER, shp INTEGER, gwg INTEGER, otg INTEGER,
    evg INTEGER, evp INTEGER,
    PRIMARY KEY (game_id, player_id)
);
CREATE TABLE IF NOT EXISTS goalie_games (
    game_id BIGINT, player_id BIGINT, team_abbrev VARCHAR, opp_abbrev VARCHAR,
    is_home BOOLEAN, season INTEGER, game_type VARCHAR, game_date DATE,
    name VARCHAR, sweater INTEGER, started BOOLEAN, decision VARCHAR,
    shots_against INTEGER, saves INTEGER, goals_against INTEGER,
    ev_saves INTEGER, ev_shots INTEGER, pp_saves INTEGER, pp_shots INTEGER,
    sh_saves INTEGER, sh_shots INTEGER, pim INTEGER, toi_sec INTEGER,
    PRIMARY KEY (game_id, player_id)
);
CREATE TABLE IF NOT EXISTS players (
    player_id BIGINT PRIMARY KEY, first_name VARCHAR, last_name VARCHAR,
    full_name VARCHAR, position VARCHAR, shoots VARCHAR, birth_date DATE,
    birth_country VARCHAR, height_in INTEGER, weight_lb INTEGER, sweater INTEGER,
    current_team VARCHAR, is_active BOOLEAN,
    updated_at TIMESTAMP DEFAULT current_timestamp
);
CREATE TABLE IF NOT EXISTS teams (
    abbrev VARCHAR PRIMARY KEY, name VARCHAR, common_name VARCHAR, place VARCHAR,
    conference VARCHAR, division VARCHAR
);
CREATE TABLE IF NOT EXISTS upcoming_games (
    game_id BIGINT PRIMARY KEY, season INTEGER, game_type VARCHAR, game_date DATE,
    start_utc VARCHAR, home_abbrev VARCHAR, away_abbrev VARCHAR, game_state VARCHAR
);
-- Full NHL career by team (from each player's NHL.com profile), reaching back
-- before the seasons loaded here. Regular season + playoffs.
CREATE TABLE IF NOT EXISTS player_career_teams (
    player_id BIGINT, team_name VARCHAR, gp INTEGER, first_season INTEGER, last_season INTEGER,
    PRIMARY KEY (player_id, team_name)
);
CREATE TABLE IF NOT EXISTS run_log (
    run_at TIMESTAMP DEFAULT current_timestamp, command VARCHAR, detail VARCHAR
);
"""

VIEWS = """
-- Team game log with schedule context: rest days, back-to-backs (1st / 2nd night),
-- game number, and where the game falls in a road trip or home stand.
CREATE OR REPLACE VIEW v_team_games AS
WITH base AS (
    SELECT tg.*,
           date_diff('day', lag(tg.game_date) OVER w, tg.game_date) - 1 AS rest_days,
           date_diff('day', tg.game_date, lead(tg.game_date) OVER w) - 1 AS next_rest,
           row_number() OVER w AS game_num,
           CASE WHEN tg.is_home = lag(tg.is_home) OVER w THEN 0 ELSE 1 END AS new_stretch
    FROM team_games tg
    WINDOW w AS (PARTITION BY tg.team_abbrev, tg.season ORDER BY tg.game_date, tg.game_id)),
stretch AS (
    SELECT *, sum(new_stretch) OVER (PARTITION BY team_abbrev, season ORDER BY game_date, game_id
                                     ROWS UNBOUNDED PRECEDING) AS stretch_id
    FROM base)
SELECT * EXCLUDE (new_stretch, stretch_id),
       row_number() OVER s AS trip_game,      -- nth game of this road trip / home stand
       count(*) OVER (PARTITION BY team_abbrev, season, stretch_id) AS trip_len,
       CASE WHEN rest_days = 0 THEN '2nd' WHEN next_rest = 0 THEN '1st' END AS b2b
FROM stretch
WINDOW s AS (PARTITION BY team_abbrev, season, stretch_id ORDER BY game_date, game_id);

-- Skater game log with enrichment + team context.
CREATE OR REPLACE VIEW v_skater_games AS
SELECT s.*, x.ppp, x.shg, x.shp, x.gwg, x.otg, x.evg, x.evp,
       t.result AS team_result, t.rest_days, t.gf AS team_gf, t.ga AS team_ga,
       t.b2b, t.trip_game, t.trip_len
FROM skater_games s
LEFT JOIN skater_extra x USING (game_id, player_id)
LEFT JOIN v_team_games t ON t.game_id = s.game_id AND t.team_abbrev = s.team_abbrev;

CREATE OR REPLACE VIEW v_goalie_games AS
SELECT g.*, t.result AS team_result, t.rest_days, t.b2b, t.trip_game, t.trip_len
FROM goalie_games g
LEFT JOIN v_team_games t ON t.game_id = g.game_id AND t.team_abbrev = g.team_abbrev;
"""


def connect(path: str | None = None) -> duckdb.DuckDBPyConnection:
    path = path or DB_PATH
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    con = duckdb.connect(path)
    con.execute(SCHEMA)
    con.execute(VIEWS)
    return con


def upsert(con: duckdb.DuckDBPyConnection, table: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    df = pd.DataFrame(rows)
    cols = [r[0] for r in con.execute(f"DESCRIBE {table}").fetchall()]
    df = df[[c for c in df.columns if c in cols]]
    con.register("_incoming", df)
    try:
        col_list = ", ".join(df.columns)
        con.execute(f"INSERT OR REPLACE INTO {table} ({col_list}) SELECT {col_list} FROM _incoming")
    finally:
        con.unregister("_incoming")
    return len(df)


def log_run(con, command: str, detail: str) -> None:
    con.execute("INSERT INTO run_log (command, detail) VALUES (?, ?)", [command, detail])
