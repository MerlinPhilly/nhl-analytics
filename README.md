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
| **Player** | Bio; filters for season, game type, home/away, opponent, team result, rest days, month, last N games and date range; summary tiles; rolling trend chart; percentile ranks vs league peers; splits (season, home/away, month, opponent, opponent's division, result, rest, road-trip game #, trip length, back-to-back 1st/2nd night, day of week, former teams); Scoring patterns (how often a point/goal follows a point/goal game); Matchup card vs any opponent; full game log; season-by-season table. Goalies get a goalie version (SV%, GAA, even-strength and penalty-kill SV%, quality starts). |
| **Team** | Same filters; record, goals for/against, shot share, PP%, PK%, PDO; results strip; trend charts; splits; skater and goalie tables; game log |
| **Trends** | Who's hot and cold right now: hottest/coldest skaters and goalies, all 32 teams ranked by form, plus "likely to cool off" (hot streaks built on unsustainable shooting), "due to heat up" (shots still coming, pucks not going in) and ice-time role changes |
| **Revenge games** | Players facing a team they played 80+ games for (adjustable: 50/80/150/250), using each player's full NHL career from NHL.com profiles. Shown on Trends (next 7 days), the home page, a "Next game" line on player pages, an Upcoming card on team pages, and a "Former teams" split showing how a player has done against his old clubs |
| **Situational edges** (Trends) | League-wide: who's meaningfully better or worse on the road, on the 2nd night of back-to-backs, late in long road trips, on a given day of the week, and vs this week's opponents; streaky scorers; goalies; team situational points %. Every row shows sample sizes and an evidence grade, and every tab has a signal check (strong patterns found vs how many chance alone would produce) |
| **Screener** | Every skater, goalie or team for a season, sortable on any column, with last-10-vs-season trend columns highlighted |
| **Compare** | Two players or two teams side by side over the same filters, with an overlaid trend |
| **Games** | Results by date, plus a box score for every game |

Every table has a **Download CSV** button, so you can take any cut into Excel.

## Colors and form

Every ranking uses one standard scale: **green = good, gray = middle, orange/red = bad**. That covers stat-box tiers (Elite 90th+ percentile, Above avg 70+, Average 30+, Below avg 10+, Bottom 10%), percentile bars, screener highlights, form badges and the results strip. Every colored mark also carries a text label.

**Form** (`nhl/trends.py`) compares each player's or team's last 10 and last 5 games with what we'd expect from them. Expectation = earlier games this season blended with last season (or the league average for the position). The size of the gap is scored with exact odds: +0.9 or more is Warming, +1.8 or more is Hot, and the same thresholds below zero mean Cooling and Cold. Goalies use save % over their last 5 and 10 games; teams use points % plus goal differential over the last 10. Each badge lists its reasons (point streaks, shot volume, ice-time changes, shooting-% luck).

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
