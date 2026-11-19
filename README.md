# NHL Analytics

A personal NHL research platform covering the current season plus the previous five. It includes game results, box scores, player and team game logs, splits, trends and a screener. The data refreshes nightly on its own.

**How it works**

```
NHL public API ──► GitHub Actions (5:17 AM ET nightly) ──► DuckDB database ──► JSON ──► website (GitHub Pages)
                    nhl/ingest.py                          stored as a          nhl/export.py   site/
                                                           release file
```

- **Data source:** the NHL's own free stats feeds: `api-web.nhle.com` for schedules, box scores and players, and `api.nhle.com/stats/rest` for power-play and short-handed points and game-winning goals. No API key is needed. The feeds are undocumented, so the NHL can change them without notice. If that happens, the nightly job shows a red ✗ in the Actions tab.
- **Database:** a single DuckDB file (`nhl.duckdb`). It's stored as a file on the repo's `data-store` release rather than committed to the repo, so the repo stays small.
- **Website:** a static site with no server. Each night's run rebuilds it.

## One-time setup (about 10 minutes)

1. **Turn on Pages.** In the repo, go to *Settings → Pages → Build and deployment → Source* and choose **GitHub Actions**.
2. **Load the history.** Go to *Actions → Backfill history → Run workflow*, keep the default seasons, and click *Run*. Six seasons is about 8,000 games, which takes roughly an hour. If it stops partway, run it again: it skips games it already has and picks up where it left off.
3. **Open the site.** When the backfill finishes, the site is at `https://<your-username>.github.io/nhl-analytics/`.

After that, **Nightly update** runs every morning by itself. To refresh mid-day, use *Actions → Nightly update → Run workflow*.

## What's on the site

| Page | What you get |
|---|---|
| **Home** | Last night's results, points/goals leaders, hottest players (last 10 vs season), save % leaders, standings by division |
| **Player** | Bio; filters for season, game type, home/away, opponent, team result, rest days, month, last N games and date range; summary tiles; rolling trend chart; percentile ranks vs league peers; splits (season, home/away, month, opponent, opponent's division, result, rest, day of week); full game log; season-by-season table. Goalies get a goalie version (SV%, GAA, even-strength and penalty-kill SV%, quality starts). |
| **Team** | Same filters; record, goals for/against, shot share, PP%, PK%, PDO; results strip; trend charts; splits; skater and goalie tables; game log |
| **Screener** | Every skater, goalie or team for a season, sortable on any column, with last-10-vs-season trend columns highlighted |
| **Compare** | Two players or two teams side by side over the same filters, with an overlaid trend |
| **Games** | Results by date, plus a box score for every game |

Every table has a **Download CSV** button, so you can take any cut into Excel.

## Running it on your Mac (optional)

```bash
pip install -r requirements.txt
python -m nhl.ingest backfill            # one time, about an hour
python -m nhl.ingest daily               # any time after
python -m nhl.export --out _site/data && cp -r site/* _site/
cd _site && python -m http.server 8000   # open http://localhost:8000
```

You can also query the database directly: `duckdb data/nhl.duckdb`, then for example
`SELECT * FROM v_skater_games WHERE name LIKE '%Hughes%' ORDER BY game_date DESC LIMIT 10;`

**Main tables and views:** `games`, `team_games` / `v_team_games` (adds rest days and game number), `skater_games` / `v_skater_games` (adds PPP, SHP, GWG, team result and rest), `goalie_games` / `v_goalie_games`, `players`, `teams`, `run_log`.

## Tests

`python -m pytest tests -q` runs the whole pipeline against a local mock of the NHL API (`tests/mock_nhl.py`), which uses a fictional league.

## Notes

- This is personal, non-commercial use of the NHL's public feeds. Any commercial use would need a licensed data provider.
- **Not yet included (planned for version 2):** play-by-play (shot maps, expected goals), MoneyPuck advanced stats, and a live in-game scoreboard.
