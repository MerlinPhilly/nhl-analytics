"""A local stand-in for the NHL API, used to test the pipeline end to end.

Generates a fictional league (real team codes, made-up players and results)
and serves it with the same URL shapes and JSON layout as api-web.nhle.com
and api.nhle.com/stats/rest.

    python tests/mock_nhl.py --port 8765
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TEAMS = {  # abbrev: (place, common name, conference, division)
    "ANA": ("Anaheim", "Ducks", "Western", "Pacific"), "BOS": ("Boston", "Bruins", "Eastern", "Atlantic"),
    "BUF": ("Buffalo", "Sabres", "Eastern", "Atlantic"), "CGY": ("Calgary", "Flames", "Western", "Pacific"),
    "CAR": ("Carolina", "Hurricanes", "Eastern", "Metropolitan"), "CHI": ("Chicago", "Blackhawks", "Western", "Central"),
    "COL": ("Colorado", "Avalanche", "Western", "Central"), "CBJ": ("Columbus", "Blue Jackets", "Eastern", "Metropolitan"),
    "DAL": ("Dallas", "Stars", "Western", "Central"), "DET": ("Detroit", "Red Wings", "Eastern", "Atlantic"),
    "EDM": ("Edmonton", "Oilers", "Western", "Pacific"), "FLA": ("Florida", "Panthers", "Eastern", "Atlantic"),
    "LAK": ("Los Angeles", "Kings", "Western", "Pacific"), "MIN": ("Minnesota", "Wild", "Western", "Central"),
    "MTL": ("Montréal", "Canadiens", "Eastern", "Atlantic"), "NSH": ("Nashville", "Predators", "Western", "Central"),
    "NJD": ("New Jersey", "Devils", "Eastern", "Metropolitan"), "NYI": ("New York", "Islanders", "Eastern", "Metropolitan"),
    "NYR": ("New York", "Rangers", "Eastern", "Metropolitan"), "OTT": ("Ottawa", "Senators", "Eastern", "Atlantic"),
    "PHI": ("Philadelphia", "Flyers", "Eastern", "Metropolitan"), "PIT": ("Pittsburgh", "Penguins", "Eastern", "Metropolitan"),
    "SJS": ("San Jose", "Sharks", "Western", "Pacific"), "SEA": ("Seattle", "Kraken", "Western", "Pacific"),
    "STL": ("St. Louis", "Blues", "Western", "Central"), "TBL": ("Tampa Bay", "Lightning", "Eastern", "Atlantic"),
    "TOR": ("Toronto", "Maple Leafs", "Eastern", "Atlantic"), "UTA": ("Utah", "Mammoth", "Western", "Central"),
    "VAN": ("Vancouver", "Canucks", "Western", "Pacific"), "VGK": ("Vegas", "Golden Knights", "Western", "Pacific"),
    "WSH": ("Washington", "Capitals", "Eastern", "Metropolitan"), "WPG": ("Winnipeg", "Jets", "Western", "Central"),
}
FIRST = ["Alex", "Ben", "Cole", "Drew", "Eli", "Finn", "Gage", "Hank", "Ivan", "Jake", "Kyle", "Liam",
         "Max", "Noah", "Owen", "Pete", "Quinn", "Ryan", "Sam", "Tate", "Uri", "Vic", "Wade", "Zach"]
LAST = ["Abbott", "Baird", "Carver", "Dorsey", "Ellery", "Fenwick", "Garnet", "Holm", "Iverson", "Jansen",
        "Kowal", "Lindgren", "Marsh", "Nyberg", "Okafor", "Pruitt", "Quill", "Rask", "Sutter", "Toivo",
        "Ulmer", "Varga", "Whitlock", "Yardley", "Zeller", "Brandt", "Crowe", "Dahl", "Eklund", "Frost"]

SEASONS = {  # season: (first game, last regular-season game)
    20252026: (dt.date(2025, 10, 7), dt.date(2026, 4, 16)),
    20262027: (dt.date(2026, 10, 7), dt.date(2026, 11, 18)),
}


class League:
    def __init__(self, seed: int = 7):
        rnd = random.Random(seed)
        self.rnd = rnd
        self.players: dict[int, dict] = {}
        self.rosters: dict[int, dict[str, list[int]]] = {}
        self.strength = {t: rnd.uniform(0.8, 1.2) for t in TEAMS}
        pid = 8470000
        base_roster = {}
        for t in TEAMS:
            ids = []
            for i in range(22):
                pid += 1
                pos = ["C", "C", "C", "C", "L", "L", "L", "L", "R", "R", "R", "R", "C",
                       "D", "D", "D", "D", "D", "D", "D", "G", "G"][i]
                self.players[pid] = {
                    "id": pid, "first": rnd.choice(FIRST), "last": rnd.choice(LAST), "pos": pos,
                    "skill": rnd.lognormvariate(0, 0.55) * (0.45 if pos == "D" else 1.0),
                    "gsk": rnd.uniform(0.895, 0.925), "sweater": rnd.randint(2, 98),
                    "birth": dt.date(rnd.randint(1990, 2006), rnd.randint(1, 12), rnd.randint(1, 28)),
                    "shoots": rnd.choice("LR"), "h": rnd.randint(69, 77), "w": rnd.randint(175, 225),
                }
                ids.append(pid)
            base_roster[t] = ids
        self.rosters[20252026] = base_roster
        # Next season: a handful of trades so players show up on two teams.
        nxt = {t: list(v) for t, v in base_roster.items()}
        abbrevs = list(TEAMS)
        for _ in range(20):
            a, b = rnd.sample(abbrevs, 2)
            i = rnd.randrange(0, 20)
            nxt[a][i], nxt[b][i] = nxt[b][i], nxt[a][i]
        self.rosters[20262027] = nxt
        self.games: dict[int, dict] = {}
        self.extras: list[dict] = []
        for season in SEASONS:
            self._schedule(season)
        # Upcoming (not yet played) games for the next three weeks after the last played day.
        self.future: dict[int, dict] = {}
        abbrevs = list(TEAMS)
        d, n = SEASONS[20262027][1] + dt.timedelta(days=1), 9000
        while d <= dt.date.today() + dt.timedelta(days=21):
            pool = abbrevs[:]
            rnd.shuffle(pool)
            for _ in range(rnd.randint(3, 8)):
                h, a = pool.pop(), pool.pop()
                gid = 2026020000 + n
                self.future[gid] = {"id": gid, "season": 20262027, "gameType": 2, "date": d, "home": h, "away": a}
                n += 1
            d += dt.timedelta(days=1)
        # Career history before the loaded seasons, for some players (tests the NHL.com profile path).
        self.history: dict[int, list] = {}
        for pid in rnd.sample(sorted(self.players), 60):
            if self.players[pid]["pos"] == "G":
                continue
            old = rnd.choice(abbrevs)
            self.history[pid] = [(20182019, old, 82), (20192020, old, 70)]

    def _schedule(self, season: int):
        rnd = self.rnd
        start, end = SEASONS[season]
        days = (end - start).days + 1
        abbrevs = list(TEAMS)
        n = 1
        gid_base = season // 10000 * 1000000 + 20000
        last_played: dict[str, dt.date] = {}
        target = 41 * 32 if season == 20252026 else 10 ** 9
        d = start
        while d <= end and n <= target:
            pool = [t for t in abbrevs if last_played.get(t) != d]
            rnd.shuffle(pool)
            for _ in range(rnd.randint(4, 8)):
                if len(pool) < 2:
                    break
                h, a = pool.pop(), pool.pop()
                self.games[gid_base + n] = self._play(gid_base + n, season, 2, d, h, a)
                last_played[h] = last_played[a] = d
                n += 1
            d += dt.timedelta(days=1)
        if season == 20252026:  # a few playoff games
            d = dt.date(2026, 4, 20)
            for r in range(8):
                for k, (h, a) in enumerate([("CAR", "NJD"), ("FLA", "TOR"), ("COL", "DAL"), ("EDM", "VGK")]):
                    gid = season // 10000 * 1000000 + 30000 + r * 10 + k
                    self.games[gid] = self._play(gid, season, 3, d + dt.timedelta(days=r * 2),
                                                 h if r % 2 == 0 else a, a if r % 2 == 0 else h)

    def _play(self, gid, season, gtype, date, home, away):
        rnd = self.rnd
        game = {"id": gid, "season": season, "gameType": gtype, "date": date,
                "home": home, "away": away, "teams": {}}
        goals = {}
        for side, t, o in (("home", home, away), ("away", away, home)):
            lam = 3.0 * self.strength[t] / self.strength[o] * (1.06 if side == "home" else 0.95)
            goals[side] = sum(1 for _ in range(60) if rnd.random() < lam / 60)
        last = "REG"
        winner_bonus = None
        if goals["home"] == goals["away"]:
            last = "OT" if (gtype == 3 or rnd.random() < 0.6) else "SO"
            winner_bonus = rnd.choice(["home", "away"])
        for side, t, o in (("home", home, away), ("away", away, home)):
            roster = self.rosters[season][t]
            sk = [self.players[p] for p in roster if self.players[p]["pos"] != "G"]
            g1, g2 = [self.players[p] for p in roster if self.players[p]["pos"] == "G"]
            n_goals = goals[side] + (1 if winner_bonus == side and last == "OT" else 0)
            stats = {p["id"]: dict(g=0, a=0, ppp=0, ppg=0, shp=0, sog=0, hits=rnd.randint(0, 4),
                                   blk=rnd.randint(0, 3), pim=rnd.choice([0, 0, 0, 0, 2]),
                                   pm=0, toi=0, gv=rnd.randint(0, 2), tk=rnd.randint(0, 2)) for p in sk}
            weights = [p["skill"] for p in sk]
            pp_opps = rnd.randint(1, 5)
            ppg_total = 0
            for _ in range(n_goals):
                scorer = rnd.choices(sk, weights)[0]
                stats[scorer["id"]]["g"] += 1
                pp = ppg_total < pp_opps and rnd.random() < 0.22
                ppg_total += pp
                if pp:
                    stats[scorer["id"]]["ppg"] += 1
                    stats[scorer["id"]]["ppp"] += 1
                others = [p for p in sk if p is not scorer]
                for helper in rnd.sample(others, rnd.choice([0, 1, 2, 2, 2])):
                    stats[helper["id"]]["a"] += 1
                    if pp:
                        stats[helper["id"]]["ppp"] += 1
            for p in sk:
                s = stats[p["id"]]
                s["sog"] = s["g"] + max(0, int(rnd.gauss(p["skill"] * 2.2, 1.2)))
                base = 1260 if p["pos"] == "D" else 960
                s["toi"] = max(300, int(rnd.gauss(base * (0.8 + 0.25 * min(p["skill"], 2)), 120)))
                s["pm"] = rnd.choice([-1, 0, 0, 1]) + (1 if goals[side] > goals["away" if side == "home" else "home"] else 0)
            starter = g1 if rnd.random() < 0.8 else g2
            game["teams"][side] = {"abbrev": t, "stats": stats, "skaters": sk, "starter": starter,
                                   "goals": n_goals, "pp_opps": pp_opps, "ppg": ppg_total,
                                   "sog": sum(s["sog"] for s in stats.values())}
        if winner_bonus and last == "SO":
            game["teams"][winner_bonus]["goals"] += 1
        game["last"] = last
        for side in ("home", "away"):
            other = "away" if side == "home" else "home"
            T, O = game["teams"][side], game["teams"][other]
            g = T["starter"]
            ga = O["goals"] - (1 if last == "SO" and winner_bonus == other else 0)
            sa = max(O["sog"], ga)
            T["goalie"] = {"id": g["id"], "sa": sa, "ga": ga, "ppsa": min(sa, O["pp_opps"] * 2),
                           "ppga": min(ga, O["ppg"]),
                           "dec": "W" if T["goals"] > O["goals"] else ("O" if last != "REG" and gtype == 2 else "L")}
            for p in T["skaters"]:
                s = T["stats"][p["id"]]
                self.extras.append({"gameId": game["id"], "playerId": p["id"], "seasonId": season,
                                    "gameTypeId": gtype, "gameDate": date.isoformat(),
                                    "ppPoints": s["ppp"], "ppGoals": s["ppg"], "shGoals": 0,
                                    "shPoints": 0, "gameWinningGoals": 0, "otGoals": 0,
                                    "evGoals": s["g"] - s["ppg"], "evPoints": s["g"] + s["a"] - s["ppp"]})
        return game

    # ------------------------------------------------------------ renderers
    def _team_obj(self, g, side, with_score=True):
        T = g["teams"][side]
        place, common, *_ = TEAMS[T["abbrev"]]
        o = {"id": list(TEAMS).index(T["abbrev"]) + 1, "abbrev": T["abbrev"],
             "commonName": {"default": common}, "placeName": {"default": place}}
        if with_score:
            o.update(score=T["goals"], sog=T["sog"])
        return o

    def schedule(self, date: dt.date) -> dict:
        week = []
        for i in range(7):
            d = date + dt.timedelta(days=i)
            games = [{"id": g["id"], "season": g["season"], "gameType": g["gameType"],
                      "gameState": "OFF", "startTimeUTC": f"{d}T23:00:00Z",
                      "homeTeam": self._team_obj(g, "home"), "awayTeam": self._team_obj(g, "away"),
                      "gameOutcome": {"lastPeriodType": g["last"]}}
                     for g in self.games.values() if g["date"] == d]
            games += [{"id": g["id"], "season": g["season"], "gameType": g["gameType"], "gameState": "FUT",
                       "startTimeUTC": f"{d}T23:30:00Z",
                       "homeTeam": {"id": 1, "abbrev": g["home"]}, "awayTeam": {"id": 2, "abbrev": g["away"]}}
                      for g in self.future.values() if g["date"] == d]
            week.append({"date": d.isoformat(), "numberOfGames": len(games), "games": games})
        return {"nextStartDate": (date + dt.timedelta(days=7)).isoformat(),
                "previousStartDate": (date - dt.timedelta(days=7)).isoformat(), "gameWeek": week}

    def boxscore(self, gid: int) -> dict:
        g = self.games[gid]
        out = {"id": gid, "season": g["season"], "gameType": g["gameType"],
               "gameDate": g["date"].isoformat(), "venue": {"default": f"{g['home']} Arena"},
               "startTimeUTC": f"{g['date']}T23:00:00Z", "gameState": "OFF",
               "periodDescriptor": {"number": 3 if g["last"] == "REG" else (4 if g["last"] == "OT" else 5),
                                    "periodType": g["last"]},
               "homeTeam": self._team_obj(g, "home"), "awayTeam": self._team_obj(g, "away"),
               "gameOutcome": {"lastPeriodType": g["last"]}, "playerByGameStats": {}}
        for side in ("home", "away"):
            T = g["teams"][side]
            grp = {"forwards": [], "defense": [], "goalies": []}
            for p in T["skaters"]:
                s = T["stats"][p["id"]]
                grp["defense" if p["pos"] == "D" else "forwards"].append({
                    "playerId": p["id"], "sweaterNumber": p["sweater"],
                    "name": {"default": f"{p['first'][0]}. {p['last']}"}, "position": p["pos"],
                    "goals": s["g"], "assists": s["a"], "points": s["g"] + s["a"],
                    "plusMinus": s["pm"], "pim": s["pim"], "hits": s["hits"],
                    "powerPlayGoals": s["ppg"], "sog": s["sog"],
                    "faceoffWinningPctg": 0.5 if p["pos"] == "C" else 0.0,
                    "toi": f"{s['toi'] // 60:02d}:{s['toi'] % 60:02d}", "blockedShots": s["blk"],
                    "shifts": s["toi"] // 45, "giveaways": s["gv"], "takeaways": s["tk"]})
            gl = T["goalie"]
            sp = self.players[gl["id"]]
            sv = gl["sa"] - gl["ga"]
            ev_sa, ev_ga = gl["sa"] - gl["ppsa"], gl["ga"] - gl["ppga"]
            grp["goalies"].append({
                "playerId": gl["id"], "sweaterNumber": sp["sweater"],
                "name": {"default": f"{sp['first'][0]}. {sp['last']}"}, "position": "G",
                "evenStrengthShotsAgainst": f"{ev_sa - ev_ga}/{ev_sa}",
                "powerPlayShotsAgainst": f"{gl['ppsa'] - gl['ppga']}/{gl['ppsa']}",
                "shorthandedShotsAgainst": "0/0", "saveShotsAgainst": f"{sv}/{gl['sa']}",
                "savePctg": sv / gl["sa"] if gl["sa"] else 0, "evenStrengthGoalsAgainst": ev_ga,
                "powerPlayGoalsAgainst": gl["ppga"], "shorthandedGoalsAgainst": 0, "pim": 0,
                "goalsAgainst": gl["ga"], "toi": "60:00", "starter": True, "decision": gl["dec"],
                "shotsAgainst": gl["sa"], "saves": sv})
            backup = [p for p in self.rosters[g["season"]][T["abbrev"]]
                      if self.players[p]["pos"] == "G" and p != gl["id"]][0]
            bp = self.players[backup]
            grp["goalies"].append({"playerId": backup, "sweaterNumber": bp["sweater"],
                                   "name": {"default": f"{bp['first'][0]}. {bp['last']}"},
                                   "position": "G", "toi": "00:00", "starter": False,
                                   "saveShotsAgainst": "0/0", "goalsAgainst": 0})
            out["playerByGameStats"][f"{side}Team"] = grp
        return out

    def right_rail(self, gid: int) -> dict:
        g = self.games[gid]
        H, A = g["teams"]["home"], g["teams"]["away"]
        hh = sum(s["hits"] for s in H["stats"].values())
        ah = sum(s["hits"] for s in A["stats"].values())
        return {"teamGameStats": [
            {"category": "sog", "awayValue": A["sog"], "homeValue": H["sog"]},
            {"category": "faceoffWinningPctg", "awayValue": 0.48, "homeValue": 0.52},
            {"category": "powerPlay", "awayValue": f"{A['ppg']}/{A['pp_opps']}",
             "homeValue": f"{H['ppg']}/{H['pp_opps']}"},
            {"category": "hits", "awayValue": ah, "homeValue": hh},
        ]}

    def landing(self, pid: int) -> dict:
        p = self.players[pid]
        team = [t for t, r in self.rosters[20262027].items() if pid in r][0]
        return {"playerId": pid, "isActive": True, "currentTeamAbbrev": team,
                "firstName": {"default": p["first"]}, "lastName": {"default": p["last"]},
                "sweaterNumber": p["sweater"], "position": p["pos"], "heightInInches": p["h"],
                "weightInPounds": p["w"], "birthDate": p["birth"].isoformat(),
                "birthCountry": "CAN", "shootsCatches": p["shoots"], "seasonTotals": self._totals(pid)}

    def _totals(self, pid: int) -> list:
        rows = []
        name = lambda t: f"{TEAMS[t][0]} {TEAMS[t][1]}"
        for season, team, gp in self.history.get(pid, []):
            rows.append({"season": season, "gameTypeId": 2, "leagueAbbrev": "NHL", "teamName": {"default": name(team)}, "gamesPlayed": gp})
        rows.append({"season": 20202021, "gameTypeId": 2, "leagueAbbrev": "AHL", "teamName": {"default": "Somewhere"}, "gamesPlayed": 60})
        for season, roster in self.rosters.items():
            team = [t for t, r in roster.items() if pid in r][0]
            gp = sum(1 for g in self.games.values() if g["season"] == season and g["gameType"] == 2
                     and team in (g["home"], g["away"]))
            rows.append({"season": season, "gameTypeId": 2, "leagueAbbrev": "NHL", "teamName": {"default": name(team)}, "gamesPlayed": gp})
        return rows

    def standings(self) -> dict:
        return {"standings": [{"teamAbbrev": {"default": t}, "teamName": {"default": f"{v[0]} {v[1]}"},
                               "teamCommonName": {"default": v[1]}, "placeName": {"default": v[0]},
                               "conferenceName": v[2], "divisionName": v[3]} for t, v in TEAMS.items()]}

    def skater_summary(self, cayenne: str, start: int, limit: int) -> dict:
        season = re.search(r"seasonId=(\d+)", cayenne)
        gtype = re.search(r"gameTypeId=(\d+)", cayenne)
        since = re.search(r'gameDate>="([\d-]+)', cayenne)
        rows = [r for r in self.extras
                if (not season or r["seasonId"] == int(season.group(1)))
                and (not gtype or r["gameTypeId"] == int(gtype.group(1)))
                and (not since or r["gameDate"] >= since.group(1))]
        rows.sort(key=lambda r: (r["gameId"], r["playerId"]))
        return {"data": rows[start:start + limit], "total": len(rows)}


def make_handler(league: League):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            p = u.path
            try:
                if m := re.fullmatch(r"/v1/schedule/(\d{4}-\d\d-\d\d)", p):
                    body = league.schedule(dt.date.fromisoformat(m.group(1)))
                elif m := re.fullmatch(r"/v1/gamecenter/(\d+)/boxscore", p):
                    body = league.boxscore(int(m.group(1)))
                elif m := re.fullmatch(r"/v1/gamecenter/(\d+)/right-rail", p):
                    body = league.right_rail(int(m.group(1)))
                elif m := re.fullmatch(r"/v1/player/(\d+)/landing", p):
                    body = league.landing(int(m.group(1)))
                elif re.fullmatch(r"/v1/standings/[\w-]+", p):
                    body = league.standings()
                elif p == "/stats/rest/en/skater/summary":
                    body = league.skater_summary(q.get("cayenneExp", [""])[0],
                                                 int(q.get("start", [0])[0]), int(q.get("limit", [100])[0]))
                else:
                    self.send_response(404); self.end_headers(); return
            except KeyError:
                self.send_response(404); self.end_headers(); return
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    return H


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    league = League()
    print(f"mock NHL API: {len(league.games)} games on :{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(league)).serve_forever()
