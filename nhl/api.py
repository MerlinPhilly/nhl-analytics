"""Thin HTTP client for the NHL's public (undocumented) APIs.

Two hosts:
  WEB   = https://api-web.nhle.com/v1        schedules, box scores, players, standings
  STATS = https://api.nhle.com/stats/rest/en  filterable stat tables (game-level rows)

Both base URLs can be overridden with env vars NHL_WEB_BASE / NHL_STATS_BASE
(used by the test suite to point at a local mock server).
"""
from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
from typing import Any

import requests

log = logging.getLogger("nhl.api")

WEB_BASE = os.environ.get("NHL_WEB_BASE", "https://api-web.nhle.com/v1").rstrip("/")
STATS_BASE = os.environ.get("NHL_STATS_BASE", "https://api.nhle.com/stats/rest/en").rstrip("/")

# Be a polite client: cap the request rate across all threads.
MAX_RPS = float(os.environ.get("NHL_MAX_RPS", "6"))


class _RateLimiter:
    def __init__(self, rps: float):
        self.interval = 1.0 / rps if rps > 0 else 0
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        if not self.interval:
            return
        with self.lock:
            now = time.monotonic()
            wait = self.next_at - now
            self.next_at = max(now, self.next_at) + self.interval
        if wait > 0:
            time.sleep(wait)


class NotFound(Exception):
    pass


class NHLClient:
    def __init__(self, rps: float = MAX_RPS, retries: int = 5, timeout: int = 30):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "nhl-analytics personal research (github.com)"
        self.limiter = _RateLimiter(rps)
        self.retries = retries
        self.timeout = timeout

    # ---- low level -------------------------------------------------------
    def get(self, url: str, params: dict | None = None) -> Any:
        last_err: Exception | None = None
        for attempt in range(self.retries):
            self.limiter.wait()
            try:
                r = self.session.get(url, params=params, timeout=self.timeout)
                if r.status_code == 404:
                    raise NotFound(url)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise requests.HTTPError(f"{r.status_code} for {url}")
                r.raise_for_status()
                return r.json()
            except NotFound:
                raise
            except (requests.RequestException, json.JSONDecodeError) as e:
                last_err = e
                sleep = min(60, (2 ** attempt) + random.random())
                log.warning("GET %s failed (%s); retry %d in %.1fs", url, e, attempt + 1, sleep)
                time.sleep(sleep)
        raise RuntimeError(f"Giving up on {url}: {last_err}")

    def web(self, path: str, params: dict | None = None) -> Any:
        return self.get(f"{WEB_BASE}/{path.lstrip('/')}", params)

    def stats(self, path: str, params: dict | None = None) -> Any:
        return self.get(f"{STATS_BASE}/{path.lstrip('/')}", params)

    # ---- endpoints -------------------------------------------------------
    def schedule_week(self, date: str) -> dict:
        """Seven days of games starting at `date` (YYYY-MM-DD)."""
        return self.web(f"schedule/{date}")

    def boxscore(self, game_id: int) -> dict:
        return self.web(f"gamecenter/{game_id}/boxscore")

    def right_rail(self, game_id: int) -> dict:
        """Holds team-level game stats (power play, faceoffs, hits...)."""
        return self.web(f"gamecenter/{game_id}/right-rail")

    def player_landing(self, player_id: int) -> dict:
        return self.web(f"player/{player_id}/landing")

    def standings(self, date: str = "now") -> dict:
        return self.web(f"standings/{date}")

    def skater_game_rows(self, cayenne: str) -> list[dict]:
        """Game-level skater summary rows from the stats API, all pages."""
        rows: list[dict] = []
        start, limit = 0, 100
        sort = json.dumps([{"property": "gameId", "direction": "ASC"},
                           {"property": "playerId", "direction": "ASC"}])
        while True:
            data = self.stats("skater/summary", params={
                "isAggregate": "false", "isGame": "true", "start": start,
                "limit": limit, "sort": sort, "cayenneExp": cayenne})
            page = data.get("data", []) if isinstance(data, dict) else []
            rows.extend(page)
            total = data.get("total", 0) if isinstance(data, dict) else 0
            start += limit
            if not page or start >= total:
                break
        return rows
