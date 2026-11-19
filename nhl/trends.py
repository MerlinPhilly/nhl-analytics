"""Hot / cold form detection.

For every skater, goalie and team, compare the most recent games with what
we'd *expect* from them, and flag only gaps too big to be ordinary noise.

Expected rate = games earlier this season, blended with last season's rate
(or the league average for the position) so a 6-game sample doesn't swing
wildly. "Too big to be noise" = a z-score: how many standard deviations the
recent total sits from expectation (Poisson for counts such as points and
shots, binomial for save %).

Status from the combined score:
    >= +1.8  hot        >= +0.9  warming        between  steady
    <= -0.9  cooling    <= -1.8  cold
"""
from __future__ import annotations

import math
from statistics import NormalDist

import pandas as pd

HOT, WARM, COOL, COLD = 1.8, 0.9, -0.9, -1.8
K_GAMES = 15          # prior weight, in games, for skater/team baselines
K_SHOTS = 400         # prior weight, in shots faced, for goalie save %


def status_of(score: float) -> str:
    if score >= HOT:
        return "hot"
    if score >= WARM:
        return "warming"
    if score <= COLD:
        return "cold"
    if score <= COOL:
        return "cooling"
    return "steady"


_N = NormalDist()


def _pois_cdf(k: int, lam: float) -> float:
    if k < 0:
        return 0.0
    term = total = math.exp(-lam)
    for i in range(1, int(k) + 1):
        term *= lam / i
        total += term
    return min(1.0, total)


def _z_pois(obs: float, exp: float) -> float:
    """Exact Poisson surprise, expressed as a normal z-score (mid-p), so hot and
    cold are judged on equal footing even for low scorers."""
    lam = max(exp, 0.05)
    k = int(round(obs))
    below = _pois_cdf(k - 1, lam)
    at = _pois_cdf(k, lam) - below
    p = min(max(below + 0.5 * at, 1e-6), 1 - 1e-6)   # P(X < obs) + half of P(X = obs)
    return _N.inv_cdf(p)


def _streak(flags) -> int:
    """Length of the run of True values at the end of a sequence."""
    n = 0
    for f in reversed(list(flags)):
        if not f:
            break
        n += 1
    return n


def _toi(sec: float) -> str:
    sec = abs(int(round(sec)))
    return f"{sec // 60}:{sec % 60:02d}"


def _r(x, d=3):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), d)


def _prev_season(season: int) -> int:
    y = season // 10000
    return (y - 1) * 10000 + y


# ---------------------------------------------------------------- skaters
def skater_form(con, season: int) -> dict:
    g = con.execute("""
        SELECT player_id, game_id, game_date, position, goals, assists, points, sog, toi_sec, ppp
        FROM v_skater_games WHERE season = ? ORDER BY player_id, game_date, game_id""", [season]).df()
    if g.empty:
        return {}
    as_of = g["game_date"].max()
    prev = con.execute("""
        SELECT player_id, count(*) gp, sum(points) p, sum(sog) sog, sum(goals) g, avg(toi_sec) toi
        FROM skater_games WHERE season = ? AND game_type = 'R' GROUP BY 1""",
                       [_prev_season(season)]).df().set_index("player_id")
    career = con.execute("SELECT player_id, sum(goals) g, sum(sog) sog FROM skater_games GROUP BY 1") \
        .df().set_index("player_id")
    g["grp"] = g["position"].map(lambda p: "D" if p == "D" else "F")
    lg = g.groupby("grp").agg(p=("points", "mean"), sog=("sog", "mean"), toi=("toi_sec", "mean"))
    lg_sh = g["goals"].sum() / max(1, g["sog"].sum())

    out = {}
    for pid, d in g.groupby("player_id", sort=False):
        n = len(d)
        if n < 8:
            continue
        grp = d["grp"].iloc[-1]
        w = min(10, n)
        recent, prior, last5 = d.iloc[-w:], d.iloc[:-w], d.iloc[-5:]

        def base(col, prev_col, lg_val):
            pv = lg_val
            if pid in prev.index and prev.at[pid, "gp"] >= 20:
                pv = prev.at[pid, prev_col] / prev.at[pid, "gp"] if prev_col != "toi" else prev.at[pid, "toi"]
            return (prior[col].sum() + K_GAMES * pv) / (len(prior) + K_GAMES)

        bp = base("points", "p", lg.at[grp, "p"])
        bs = base("sog", "sog", lg.at[grp, "sog"])
        bt = (prior["toi_sec"].sum() + K_GAMES * (prev.at[pid, "toi"] if pid in prev.index and prev.at[pid, "gp"] >= 20
                                                 else lg.at[grp, "toi"])) / (len(prior) + K_GAMES)

        p10, p5 = recent["points"].sum(), last5["points"].sum()
        z10, z5 = _z_pois(p10, bp * w), _z_pois(p5, bp * len(last5))
        score = 0.6 * z10 + 0.4 * z5
        if bp * w < 2.5 and score < 0:   # a low scorer can't be "cold" on points
            score = max(score, -0.85)

        s10, g10 = recent["sog"].sum(), recent["goals"].sum()
        zs = _z_pois(s10, bs * w)
        toi10 = recent["toi_sec"].mean()
        dtoi = toi10 - bt
        cg, cs = (career.at[pid, "g"], career.at[pid, "sog"]) if pid in career.index else (0, 0)
        car_sh = (cg + 100 * lg_sh) / (cs + 100)     # shrink career shooting % toward league
        sh10 = g10 / s10 if s10 >= 10 else None

        pts = d["points"].tolist()
        pt_streak = _streak([x > 0 for x in pts])
        g_streak = _streak([x > 0 for x in d["goals"]])
        dry = _streak([x == 0 for x in pts])

        st = status_of(score)
        reasons, flags = [], []
        reasons.append(f"{int(p10)} pts in last {w} ({p10 / w:.2f}/GP) vs {bp:.2f}/GP expected")
        if pt_streak >= 3:
            reasons.append(f"{pt_streak}-game point streak")
        if g_streak >= 3:
            reasons.append(f"{g_streak}-game goal streak")
        if dry >= 5:
            reasons.append(f"{dry} straight games without a point")
        if abs(zs) >= 1.5:
            reasons.append(f"Shots {'up' if zs > 0 else 'down'}: {s10 / w:.1f}/GP last {w} vs {bs:.1f}/GP expected")
        if dtoi >= 90:
            reasons.append(f"Ice time up {_toi(dtoi)}/game ({_toi(toi10)} last {w}) — bigger role")
            flags.append("role_up")
        elif dtoi <= -90:
            reasons.append(f"Ice time down {_toi(dtoi)}/game ({_toi(toi10)} last {w}) — smaller role")
            flags.append("role_down")
        if sh10 is not None and g10 >= 4 and sh10 - car_sh >= 0.10:
            reasons.append(f"Shooting {sh10:.0%} last {w} vs {car_sh:.0%} career — likely to cool off")
            flags.append("regression_risk")
        if st in ("cold", "cooling") and zs > -0.5 and sh10 is not None and sh10 < car_sh - 0.04:
            reasons.append(f"Shots are still coming; finishing {sh10:.0%} vs {car_sh:.0%} career — due to heat up")
            flags.append("buy_low")

        out[int(pid)] = {
            "status": st, "score": _r(score, 2), "window": w, "reasons": reasons, "flags": flags,
            "p_recent": int(p10), "p_exp": _r(bp * w, 1), "sog_z": _r(zs, 2),
            "toi_delta": _r(dtoi, 0), "pt_streak": pt_streak, "g_streak": g_streak, "dry": dry,
            "last_game": str(d["game_date"].iloc[-1])[:10],
        }
    return {"as_of": str(as_of)[:10], "players": out}


# ---------------------------------------------------------------- goalies
def goalie_form(con, season: int) -> dict:
    g = con.execute("""
        SELECT player_id, game_date, shots_against sa, saves sv, goals_against ga, started
        FROM goalie_games WHERE season = ? AND shots_against > 0
        ORDER BY player_id, game_date, game_id""", [season]).df()
    if g.empty:
        return {}
    lg_sv = g["sv"].sum() / max(1, g["sa"].sum())
    prev = con.execute("SELECT player_id, sum(saves) sv, sum(shots_against) sa FROM goalie_games "
                       "WHERE season = ? GROUP BY 1", [_prev_season(season)]).df().set_index("player_id")
    out = {}
    for pid, d in g.groupby("player_id", sort=False):
        if len(d) < 5:
            continue
        pv = lg_sv
        if pid in prev.index and prev.at[pid, "sa"] >= 500:
            pv = prev.at[pid, "sv"] / prev.at[pid, "sa"]

        def z_for(k):
            rec, pri = d.iloc[-k:], d.iloc[:-k]
            b = (pri["sv"].sum() + K_SHOTS * pv) / (pri["sa"].sum() + K_SHOTS)
            sa, sv = rec["sa"].sum(), rec["sv"].sum()
            return (sv - sa * b) / math.sqrt(max(1.0, sa * b * (1 - b))), b, sv / sa, rec

        z5, b5, sv5, rec5 = z_for(min(5, len(d)))
        z10, _, sv10, _ = z_for(min(10, len(d)))
        score = 0.6 * z5 + 0.4 * z10
        qs = [(r.sv / r.sa) >= 0.9 for r in d.itertuples()]
        qs_streak, bad = _streak(qs), _streak([r.ga >= 4 for r in d.itertuples()])
        reasons = [f"{sv5:.3f} save % last {len(rec5)} games vs {b5:.3f} expected".replace("0.", ".")]
        if qs_streak >= 3:
            reasons.append(f"{qs_streak} straight quality starts (.900+)")
        if bad >= 2:
            reasons.append(f"Allowed 4+ goals in {bad} straight")
        reasons.append(f"{rec5['ga'].sum()} goals on {rec5['sa'].sum()} shots last {len(rec5)}")
        out[int(pid)] = {"status": status_of(score), "score": _r(score, 2), "reasons": reasons, "flags": [],
                         "sv_recent": _r(sv5), "sv_exp": _r(b5), "qs_streak": qs_streak,
                         "last_game": str(d["game_date"].iloc[-1])[:10]}
    return {"as_of": str(g["game_date"].max())[:10], "players": out}


# ---------------------------------------------------------------- teams
def team_form(con, season: int) -> dict:
    g = con.execute("""
        SELECT team_abbrev, game_date, result, gf, ga, sog_for sf, sog_against sa, pp_goals, pp_opps
        FROM team_games WHERE season = ? ORDER BY team_abbrev, game_date, game_id""", [season]).df()
    if g.empty:
        return {}
    prev = con.execute("""SELECT team_abbrev, avg(CASE result WHEN 'W' THEN 1 WHEN 'OTL' THEN .5 ELSE 0 END) p,
                          avg(gf - ga) gd FROM team_games WHERE season = ? AND game_type = 'R' GROUP BY 1""",
                       [_prev_season(season)]).df().set_index("team_abbrev")
    g["pf"] = g["result"].map({"W": 1.0, "OTL": 0.5, "L": 0.0})
    out = {}
    for team, d in g.groupby("team_abbrev", sort=False):
        n = len(d)
        if n < 8:
            continue
        w = min(10, n)
        rec, pri = d.iloc[-w:], d.iloc[:-w]
        pp_prev = prev.at[team, "p"] if team in prev.index else 0.5
        gd_prev = prev.at[team, "gd"] if team in prev.index else 0.0
        bp = (pri["pf"].sum() + K_GAMES * pp_prev) / (len(pri) + K_GAMES)
        bgd = ((pri["gf"] - pri["ga"]).sum() + K_GAMES * gd_prev) / (len(pri) + K_GAMES)
        p10 = rec["pf"].mean()
        z_p = (p10 - bp) / math.sqrt(max(0.05, bp * (1 - bp)) / w)
        gd10 = (rec["gf"] - rec["ga"]).sum()
        z_gd = (gd10 - bgd * w) / (2.4 * math.sqrt(w))
        score = 0.5 * z_p + 0.5 * z_gd
        wins = d["result"].tolist()
        win_streak = _streak([r == "W" for r in wins])
        skid = _streak([r != "W" for r in wins])
        w_, l_, o_ = (rec["result"] == "W").sum(), (rec["result"] == "L").sum(), (rec["result"] == "OTL").sum()
        reasons = [f"{w_}-{l_}-{o_} last {w} ({p10:.3f} points %) vs {bp:.3f} expected".replace("0.", ".")]
        if win_streak >= 3:
            reasons.append(f"{win_streak}-game win streak")
        if skid >= 3:
            reasons.append(f"{skid} straight without a win")
        reasons.append(f"Goal diff {gd10:+d} last {w} ({rec['gf'].mean():.1f} for, {rec['ga'].mean():.1f} against per game)")
        flags = []
        sf, sa = rec["sf"].sum(), rec["sa"].sum()
        if sf and sa:
            pdo = rec["gf"].sum() / sf + 1 - rec["ga"].sum() / sa
            share = sf / (sf + sa)
            if pdo >= 1.03 and share < 0.5:
                reasons.append(f"Winning on finishing/goaltending (PDO {pdo * 1000:.0f}) while outshot ({share:.0%} of shots) — may not last")
                flags.append("regression_risk")
            elif pdo <= 0.97 and share > 0.5:
                reasons.append(f"Outshooting opponents ({share:.0%} of shots) but bounces aren't going their way (PDO {pdo * 1000:.0f}) — due to turn")
                flags.append("buy_low")
        ppo = rec["pp_opps"].sum()
        if ppo and ppo >= 15:
            pp10 = rec["pp_goals"].sum() / ppo
            pp_all = d["pp_goals"].sum() / max(1, d["pp_opps"].sum())
            if abs(pp10 - pp_all) >= 0.08:
                reasons.append(f"Power play {pp10:.0%} last {w} vs {pp_all:.0%} season")
        out[team] = {"status": status_of(score), "score": _r(score, 2), "window": w, "reasons": reasons,
                     "flags": flags, "win_streak": win_streak, "skid": skid,
                     "last_game": str(d["game_date"].iloc[-1])[:10]}
    return {"as_of": str(g["game_date"].max())[:10], "teams": out}


def season_form(con, season: int) -> dict:
    sk, gk, tm = skater_form(con, season), goalie_form(con, season), team_form(con, season)
    return {"as_of": sk.get("as_of") or tm.get("as_of"),
            "skaters": {str(k): v for k, v in sk.get("players", {}).items()},
            "goalies": {str(k): v for k, v in gk.get("players", {}).items()},
            "teams": tm.get("teams", {})}
