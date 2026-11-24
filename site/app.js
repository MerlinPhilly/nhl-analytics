/* NHL Analytics — static single-page app. Reads JSON exported by nhl/export.py. */
"use strict";

const DATA = "data";
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const cache = new Map();

// ------------------------------------------------------------------ utils
async function load(path) {
  if (cache.has(path)) return cache.get(path);
  // "no-cache" = always check with the server for a newer copy (cheap: unchanged files aren't re-downloaded)
  const p = fetch(`${DATA}/${path}`, { cache: "no-cache" }).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  });
  cache.set(path, p);
  try { return await p; } catch (e) { cache.delete(path); throw e; }
}
const objs = t => t ? t.rows.map(r => Object.fromEntries(t.cols.map((c, i) => [c, r[i]]))) : [];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sum = (a, k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);
const div = (a, b) => (b ? a / b : null);
const seasonLabel = s => { s = String(s); return `${s.slice(0, 4)}-${s.slice(6)}`; };
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
const fmtPct = (v, d = 1) => (v == null ? "–" : (v * 100).toFixed(d) + "%");
const fmtSv = v => (v == null ? "–" : v.toFixed(3).replace(/^0/, ""));
const fmtToi = sec => { if (sec == null) return "–"; sec = Math.round(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };
const fmtSigned = (v, d = 0) => (v == null ? "–" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
const fmtDate = d => { const x = new Date(d + "T12:00:00"); return x.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
const shortDate = d => { const x = new Date(d + "T12:00:00"); return x.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const isF = p => ["C", "L", "R"].includes(p);
const posGroup = p => (p === "G" ? "G" : p === "D" ? "D" : "F");
const restLabel = r => (r == null ? "Season opener" : r === 0 ? "Back-to-back" : r === 1 ? "1 day rest" : r === 2 ? "2 days rest" : "3+ days rest");
const h = (strings, ...vals) => strings.reduce((s, str, i) => s + str + (i < vals.length ? vals[i] : ""), "");

let META = null, TEAMS = [], TEAM_BY = {}, INDEX = [];

// ------------------------------------------------------------------ tooltip
const tip = $("#tooltip");
function showTip(html, x, y) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = left + "px"; tip.style.top = top + "px";
}
const hideTip = () => { tip.hidden = true; };

// ------------------------------------------------------------------ chart
function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Line chart with crosshair tooltip.
 *  opts = { series:[{name,color,values,dots}], ref:{value,label}, yFmt, xLabels, tipRows(i), height, zeroBase } */
function lineChart(el, opts) {
  const draw = () => {
    const W = el.clientWidth || 800, H = opts.height || 240, m = { l: 44, r: 14, t: 12, b: 26 };
    const n = Math.max(...opts.series.map(s => s.values.length));
    if (!n) { el.innerHTML = `<div class="empty">No games match these filters.</div>`; return; }
    const all = opts.series.flatMap(s => [...s.values, ...(s.dots || [])]).filter(v => v != null);
    if (opts.ref?.value != null) all.push(opts.ref.value);
    let lo = Math.min(...all), hi = Math.max(...all);
    if (opts.zeroBase !== false && lo >= 0) lo = 0;
    const ticks = niceTicks(lo, hi);
    lo = ticks[0]; hi = ticks[ticks.length - 1];
    const x = i => m.l + (n === 1 ? (W - m.l - m.r) / 2 : (i / (n - 1)) * (W - m.l - m.r));
    const y = v => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
    const yFmt = opts.yFmt || (v => fmt(v, Math.abs(hi - lo) < 3 ? 2 : 0));
    let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(opts.title || "chart")}">`;
    for (const t of ticks) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${yFmt(t)}</text>`;
    const xl = opts.xLabels || [];
    const idxs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 3), Math.floor(2 * (n - 1) / 3), n - 1];
    for (const i of [...new Set(idxs)]) if (xl[i]) svg += `<text class="axis-label" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(xl[i])}</text>`;
    if (opts.ref?.value != null) svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(opts.ref.value)}" y2="${y(opts.ref.value)}"/>`;
    for (const s of opts.series) {
      if (s.dots) s.dots.forEach((v, i) => { if (v != null) svg += `<circle class="dot" cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${s.color}"/>`; });
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
      svg += `<path class="line" d="${d}" stroke="${s.color}"/>`;
    }
    svg += `<g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/>${opts.series.map(s => `<circle class="hover-dot" r="4.5" fill="${s.color}"/>`).join("")}</g>`;
    svg += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/></svg>`;
    el.innerHTML = svg;
    const hover = el.querySelector(".hover"), hit = el.querySelector(".hit"), svgEl = el.querySelector("svg");
    hit.addEventListener("mousemove", ev => {
      const r = svgEl.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - m.l) / (W - m.l - m.r)) * (n - 1))));
      hover.style.display = "";
      hover.querySelector("line").setAttribute("x1", x(i)); hover.querySelector("line").setAttribute("x2", x(i));
      hover.querySelectorAll("circle").forEach((c, k) => {
        const v = opts.series[k].values[i];
        c.style.display = v == null ? "none" : ""; if (v != null) { c.setAttribute("cx", x(i)); c.setAttribute("cy", y(v)); }
      });
      showTip(opts.tipHtml(i), ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", () => { hover.style.display = "none"; hideTip(); });
  };
  draw();
  el._redraw = draw;
}
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => document.querySelectorAll(".chart").forEach(c => c._redraw && c._redraw()), 150); });

function rolling(vals, w) {
  return vals.map((_, i) => {
    const win = vals.slice(Math.max(0, i - w + 1), i + 1).filter(v => v != null);
    return i + 1 < Math.min(w, vals.length) || !win.length ? null : win.reduce((a, b) => a + b, 0) / win.length;
  });
}
function rollingRatio(num, den, w) { // e.g. save % over last w games, weighted by shots
  return num.map((_, i) => {
    if (i + 1 < Math.min(w, num.length)) return null;
    let a = 0, b = 0; for (let k = Math.max(0, i - w + 1); k <= i; k++) { a += num[k] || 0; b += den[k] || 0; }
    return b ? a / b : null;
  });
}

// ------------------------------------------------------------------ sortable table
/** cols: [{k, label, fmt?, cls?, html?(row), n?:bool, title?, cellCls?(row)}] */
function sortTable(el, rows, cols, { sortKey, desc = true, limit = 0, csvName, full = false } = {}) {
  let key = sortKey, dsc = desc;
  const render = () => {
    const c = cols.find(c => c.k === key);
    const val = r => (c?.sortVal ? c.sortVal(r) : r[key]);
    const sorted = key ? [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * (dsc ? -1 : 1);
    }) : rows;
    const shown = limit ? sorted.slice(0, limit) : sorted;
    el.innerHTML = h`
      ${csvName ? `<div class="tbl-tools"><span class="muted">${rows.length} rows${limit && rows.length > limit ? ` · showing top ${limit}` : ""}</span><button class="btn csv">Download CSV</button></div>` : ""}
      <div class="tbl-wrap" ${full ? 'style="max-height:none"' : ""}><table><thead><tr>${cols.map(c => `<th data-k="${c.k}" class="${c.n ? "n" : ""} ${c.k === key ? "sorted" + (dsc ? "" : " asc") : ""}" title="${esc(c.title || "")}">${c.label}</th>`).join("")}</tr></thead>
      <tbody>${shown.map(r => `<tr>${cols.map(c => `<td class="${c.n ? "n" : ""} ${c.cellCls ? c.cellCls(r) : ""}">${c.html ? c.html(r) : esc(c.fmt ? c.fmt(r[c.k], r) : r[c.k] ?? "–")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    el.querySelectorAll("th").forEach(th => th.onclick = () => {
      if (key === th.dataset.k) dsc = !dsc; else { key = th.dataset.k; dsc = true; }
      render();
    });
    const btn = el.querySelector(".csv");
    if (btn) btn.onclick = () => downloadCsv(csvName, sorted, cols);
  };
  render();
}
function downloadCsv(name, rows, cols) {
  const q = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(c => q(c.label)).join(",")];
  for (const r of rows) lines.push(cols.map(c => q(c.csv ? c.csv(r) : c.fmt ? c.fmt(r[c.k], r) : r[c.k])).join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `${name}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ aggregations
function aggSkater(g) {
  const gp = g.length, goals = sum(g, "goals"), sog = sum(g, "sog"), pts = sum(g, "points");
  const fo = g.filter(x => x.faceoff_pct != null && x.position === "C");
  return {
    gp, g: goals, a: sum(g, "assists"), p: pts, ppg_rate: div(pts, gp), gpg: div(goals, gp),
    sog, sog_rate: div(sog, gp), shpct: div(goals, sog), pm: sum(g, "plus_minus"), pim: sum(g, "pim"),
    hits: sum(g, "hits"), blk: sum(g, "blocks"), ppp: sum(g, "ppp"), ppgoals: sum(g, "ppg"), shp: sum(g, "shp"),
    gwg: sum(g, "gwg"), toi: div(sum(g, "toi_sec"), gp), gv: sum(g, "giveaways"), tk: sum(g, "takeaways"),
    fo: fo.length ? fo.reduce((s, x) => s + x.faceoff_pct, 0) / fo.length : null,
    multi: g.filter(x => x.points >= 2).length, pt_games: g.filter(x => x.points > 0).length,
  };
}
function aggGoalie(g) {
  const sa = sum(g, "shots_against"), sv = sum(g, "saves"), ga = sum(g, "goals_against"), toi = sum(g, "toi_sec");
  return {
    gp: g.length, gs: g.filter(x => x.started).length, w: g.filter(x => x.decision === "W").length,
    l: g.filter(x => x.decision === "L").length, otl: g.filter(x => ["O", "OT", "OTL"].includes(x.decision)).length,
    sa, sv, ga, svpct: div(sv, sa), gaa: toi ? (ga * 3600) / toi : null,
    so: g.filter(x => x.started && x.goals_against === 0 && x.shots_against > 0).length,
    evsv: div(sum(g, "ev_saves"), sum(g, "ev_shots")), ppsv: div(sum(g, "pp_saves"), sum(g, "pp_shots")),
    quality: g.filter(x => x.started).length ? g.filter(x => x.started && x.shots_against && x.saves / x.shots_against >= 0.9).length / g.filter(x => x.started).length : null,
  };
}
function aggTeam(g) {
  const gp = g.length, w = g.filter(x => x.result === "W").length, otl = g.filter(x => x.result === "OTL").length;
  const gf = sum(g, "gf"), ga = sum(g, "ga"), sf = sum(g, "sog_for"), sa = sum(g, "sog_against");
  const ppo = sum(g, "pp_opps"), pko = sum(g, "pk_opps");
  return {
    gp, w, l: g.filter(x => x.result === "L").length, otl, pts: 2 * w + otl, ptspct: div(2 * w + otl, 2 * gp),
    gf, ga, diff: gf - ga, gfpg: div(gf, gp), gapg: div(ga, gp), sf, sa, sfpg: div(sf, gp), sapg: div(sa, gp),
    sfpct: div(sf, sf + sa), pp: div(sum(g, "pp_goals"), ppo), pk: pko ? 1 - sum(g, "pk_goals_against") / pko : null,
    shpct: div(gf, sf), svpct: sa ? 1 - ga / sa : null, hits: div(sum(g, "hits"), gp), blk: div(sum(g, "blocks"), gp),
  };
}
const recordStr = a => `${a.w}-${a.l}-${a.otl}`;

// ------------------------------------------------------------------ filters
const DEFAULT_FILTER = () => ({ seasons: null, type: "R", venue: "all", opp: "all", result: "all", rest: "all", lastN: 0, from: "", to: "", month: "all" });
function applyFilter(games, f, resultKey) {
  let out = games.filter(g =>
    (!f.seasons || f.seasons.includes(g.season)) &&
    (f.type === "all" || g.game_type === f.type) &&
    (f.venue === "all" || (f.venue === "H") === !!g.is_home) &&
    (f.opp === "all" || g.opp_abbrev === f.opp) &&
    (f.month === "all" || +g.game_date.slice(5, 7) === +f.month) &&
    (f.result === "all" || (f.result === "W" ? g[resultKey] === "W" : g[resultKey] !== "W")) &&
    (f.rest === "all" || (f.rest === "0" ? g.rest_days === 0 : f.rest === "1" ? g.rest_days === 1 : (g.rest_days ?? 9) >= 2)) &&
    (!f.from || g.game_date >= f.from) && (!f.to || g.game_date <= f.to));
  if (f.lastN) out = out.slice(-f.lastN);
  return out;
}
function filterBar(f, { seasons, opps, onChange, resultLabel = "Team result" }) {
  const el = document.createElement("div");
  el.className = "card filters";
  const sel = (name, label, options, val) => `<label>${label}<select data-f="${name}">${options.map(([v, t]) => `<option value="${v}" ${String(v) === String(val) ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
  el.innerHTML = h`
    <label>Seasons<div class="chips">${seasons.map(s => `<button class="chip ${!f.seasons || f.seasons.includes(s) ? "on" : ""}" data-season="${s}">${seasonLabel(s)}</button>`).join("")}
      <button class="chip" data-season="all">All</button></div></label>
    ${sel("type", "Game type", [["R", "Regular season"], ["P", "Playoffs"], ["all", "Both"]], f.type)}
    ${sel("venue", "Venue", [["all", "Home & away"], ["H", "Home"], ["A", "Away"]], f.venue)}
    ${sel("opp", "Opponent", [["all", "All"], ...opps.map(o => [o, o])], f.opp)}
    ${sel("result", resultLabel, [["all", "All"], ["W", "Wins"], ["L", "Losses (incl. OT)"]], f.result)}
    ${sel("rest", "Rest", [["all", "Any"], ["0", "Back-to-back"], ["1", "1 day"], ["2", "2+ days"]], f.rest)}
    ${sel("month", "Month", [["all", "All"], ...[10, 11, 12, 1, 2, 3, 4, 5, 6].map(m => [m, MONTHS[m - 1]])], f.month)}
    ${sel("lastN", "Last N games", [[0, "All"], [5, "Last 5"], [10, "Last 10"], [20, "Last 20"], [40, "Last 40"]], f.lastN)}
    <label>From<input type="date" data-f="from" value="${f.from}"></label>
    <label>To<input type="date" data-f="to" value="${f.to}"></label>
    <button class="btn" data-reset>Reset</button>
    <span class="filter-note"></span>`;
  el.querySelectorAll("[data-season]").forEach(b => b.onclick = () => {
    const s = b.dataset.season;
    if (s === "all") f.seasons = null;
    else {
      const cur = f.seasons ? [...f.seasons] : [];
      const v = +s;
      // first click while "all" is active selects only that season
      f.seasons = !f.seasons ? [v] : cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v].sort();
      if (f.seasons.length === 0 || f.seasons.length === seasons.length) f.seasons = null;
    }
    onChange();
  });
  el.querySelectorAll("[data-f]").forEach(i => i.onchange = () => {
    const k = i.dataset.f; f[k] = k === "lastN" ? +i.value : i.value; onChange();
  });
  el.querySelector("[data-reset]").onclick = () => { Object.assign(f, DEFAULT_FILTER(), { seasons: f._defaultSeasons }); onChange(); };
  return el;
}

// ------------------------------------------------------------------ splits
function splitsBlock(el, games, kind, defs) {
  let current = defs[0].key;
  const aggFn = kind === "G" ? aggGoalie : kind === "T" ? aggTeam : aggSkater;
  const render = () => {
    const def = defs.find(d => d.key === current);
    const groups = new Map();
    for (const g of games) { const k = def.fn(g); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(g); }
    let rows = [...groups].map(([k, gs]) => ({ split: k, ...aggFn(gs), _order: def.order ? def.order(k) : k }));
    rows.sort((a, b) => (a._order > b._order ? 1 : -1));
    el.innerHTML = `<div class="tabs">${defs.map(d => `<button class="tab ${d.key === current ? "on" : ""}" data-k="${d.key}">${d.label}</button>`).join("")}</div><div class="split-tbl"></div>`;
    el.querySelectorAll(".tab").forEach(t => t.onclick = () => { current = t.dataset.k; render(); });
    const cols = [{ k: "split", label: def.label, sortVal: r => r._order }, ...statCols(kind)];
    sortTable(el.querySelector(".split-tbl"), rows, cols, { csvName: `splits-${current}` });
  };
  render();
}
function statCols(kind) {
  if (kind === "G") return [
    { k: "gp", label: "GP", n: 1 }, { k: "gs", label: "GS", n: 1 }, { k: "w", label: "W", n: 1 }, { k: "l", label: "L", n: 1 }, { k: "otl", label: "OTL", n: 1 },
    { k: "sa", label: "SA", n: 1 }, { k: "ga", label: "GA", n: 1 }, { k: "svpct", label: "SV%", n: 1, fmt: fmtSv }, { k: "gaa", label: "GAA", n: 1, fmt: v => fmt(v, 2) },
    { k: "so", label: "SO", n: 1 }, { k: "evsv", label: "EV SV%", n: 1, fmt: fmtSv }, { k: "ppsv", label: "PK SV%", n: 1, fmt: fmtSv },
    { k: "quality", label: "QS%", n: 1, fmt: v => fmtPct(v, 0), title: "Starts with save % ≥ .900" }];
  if (kind === "T") return [
    { k: "gp", label: "GP", n: 1 }, { k: "rec", label: "Record", html: r => recordStr(r), sortVal: r => r.ptspct }, { k: "ptspct", label: "P%", n: 1, fmt: fmtSv },
    { k: "gfpg", label: "GF/GP", n: 1, fmt: v => fmt(v, 2) }, { k: "gapg", label: "GA/GP", n: 1, fmt: v => fmt(v, 2) }, { k: "diff", label: "Diff", n: 1, fmt: v => fmtSigned(v) },
    { k: "sfpg", label: "SF/GP", n: 1, fmt: v => fmt(v, 1) }, { k: "sapg", label: "SA/GP", n: 1, fmt: v => fmt(v, 1) }, { k: "sfpct", label: "SF%", n: 1, fmt: v => fmtPct(v) },
    { k: "pp", label: "PP%", n: 1, fmt: v => fmtPct(v) }, { k: "pk", label: "PK%", n: 1, fmt: v => fmtPct(v) },
    { k: "shpct", label: "Sh%", n: 1, fmt: v => fmtPct(v) }, { k: "svpct", label: "Sv%", n: 1, fmt: fmtSv }];
  return [
    { k: "gp", label: "GP", n: 1 }, { k: "g", label: "G", n: 1 }, { k: "a", label: "A", n: 1 }, { k: "p", label: "P", n: 1 },
    { k: "ppg_rate", label: "P/GP", n: 1, fmt: v => fmt(v, 2) }, { k: "sog", label: "SOG", n: 1 }, { k: "sog_rate", label: "SOG/GP", n: 1, fmt: v => fmt(v, 2) },
    { k: "shpct", label: "Sh%", n: 1, fmt: v => fmtPct(v) }, { k: "ppp", label: "PPP", n: 1 }, { k: "pm", label: "+/-", n: 1, fmt: v => fmtSigned(v) },
    { k: "hits", label: "Hits", n: 1 }, { k: "blk", label: "Blk", n: 1 }, { k: "pim", label: "PIM", n: 1 }, { k: "toi", label: "TOI/GP", n: 1, fmt: fmtToi }];
}
function withFormerSplit(defs, former) {
  const f80 = new Map((former || []).filter(f => f.gp >= REVENGE_DEFAULT).map(f => [f.team, f.gp]));
  if (!f80.size) return defs;
  return [...defs, { key: "former", label: "Former teams", fn: g => (f80.has(g.opp_abbrev) ? `vs ${g.opp_abbrev} (former team, ${f80.get(g.opp_abbrev)} GP)` : "All other opponents"),
    order: k => (k === "All other opponents" ? "zz" : k) }];
}
function commonSplits(resultKey, teamFirst = false) {
  return [
    { key: "season", label: "Season", fn: g => seasonLabel(g.season) },
    { key: "venue", label: "Home/Away", fn: g => (g.is_home ? "Home" : "Away") },
    { key: "month", label: "Month", fn: g => MONTHS[+g.game_date.slice(5, 7) - 1], order: k => (MONTHS.indexOf(k) + 3) % 12 },
    { key: "opp", label: "Opponent", fn: g => g.opp_abbrev },
    { key: "div", label: "Opp. division", fn: g => TEAM_BY[g.opp_abbrev]?.division || "Other" },
    { key: "result", label: teamFirst ? "Result" : "Team result", fn: g => g[resultKey] || "–" },
    { key: "rest", label: "Rest", fn: g => restLabel(g.rest_days), order: k => ["Season opener", "Back-to-back", "1 day rest", "2 days rest", "3+ days rest"].indexOf(k) },
    { key: "trip", label: "Road trips", fn: g => (g.is_home ? "Home games" : g.trip_game >= 4 ? "Road trip: game 4+" : `Road trip: game ${g.trip_game}`),
      order: k => (k === "Home games" ? "0" : k) },
    { key: "triplen", label: "Trip length", fn: g => (g.is_home ? "Home games" : g.trip_len >= 5 ? "Road trip of 5+ games" : g.trip_len === 1 ? "Single road game" : `${g.trip_len}-game road trip`),
      order: k => (k === "Home games" ? "0" : k === "Single road game" ? "1" : k) },
    { key: "b2b", label: "Back-to-backs", fn: g => (g.b2b === "2nd" ? "2nd night of back-to-back" : g.b2b === "1st" ? "1st night of back-to-back" : "Not a back-to-back"),
      order: k => ["1st night of back-to-back", "2nd night of back-to-back", "Not a back-to-back"].indexOf(k) },
    { key: "dow", label: "Day of week", fn: g => DOW[new Date(g.game_date + "T12:00:00").getDay()], order: k => DOW.indexOf(k) },
    { key: "type", label: "Reg/Playoffs", fn: g => (g.game_type === "P" ? "Playoffs" : "Regular season") },
  ];
}

const tiles = items => `<div class="tiles">${items.map(([k, v, s, , rk]) => `<div class="tile ${rk ? "t-" + rk.tier[1] : ""}" ${rk ? `title="${esc(rankTitle(rk))}"` : ""}><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}${rk ? `<div class="rk"><span class="tier"><i class="sw"></i>${rk.tier[2]}</span><span class="pos">${rk.tied ? "T-" : ""}#${rk.rank} of ${rk.n} · ${ordinal(rk.pct)} pct</span></div>` : ""}</div>`).join("")}</div>`;

// ------------------------------------------------------------------ league ranks for stat tiles
// Tier bands by percentile. Color is never the only signal: every tile also prints the tier name and rank.
const TIERS = [[90, "elite", "Elite"], [70, "above", "Above avg"], [30, "avg", "Average"], [10, "below", "Below avg"], [0, "poor", "Bottom 10%"]];
const ordinal = n => { const v = n % 100; return n + (v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"); };
const rankTitle = rk => `Ranks #${rk.rank} of ${rk.n} on ${rk.basis} (${ordinal(rk.pct)} percentile${rk.lower ? ", lower is better" : ""})`;

// mine(a): value from this player's filtered games; peer(r): same stat from a league season row
const SK_RANK = {
  g: { mine: a => div(a.g, a.gp), peer: r => r.g / r.gp, basis: "goals per game" },
  a: { mine: a => div(a.a, a.gp), peer: r => r.a / r.gp, basis: "assists per game" },
  p: { mine: a => a.ppg_rate, peer: r => r.p / r.gp, basis: "points per game" },
  sog: { mine: a => a.sog_rate, peer: r => r.sog / r.gp, basis: "shots per game" },
  sh: { mine: a => (a.sog >= 10 ? a.shpct : null), peer: r => (r.sog >= 20 ? r.g / r.sog : null), basis: "shooting % (min 20 shots)" },
  ppp: { mine: a => (a.ppp == null ? null : div(a.ppp, a.gp)), peer: r => (r.ppp == null ? null : r.ppp / r.gp), basis: "PP points per game" },
  pm: { mine: a => div(a.pm, a.gp), peer: r => r.pm / r.gp, basis: "plus/minus per game" },
  toi: { mine: a => a.toi, peer: r => r.toi / r.gp, basis: "ice time per game" },
  hits: { mine: a => div(a.hits, a.gp), peer: r => r.hits / r.gp, basis: "hits per game" },
  blk: { mine: a => div(a.blk, a.gp), peer: r => r.blk / r.gp, basis: "blocks per game" },
  pim: { mine: a => div(a.pim, a.gp), peer: r => r.pim / r.gp, basis: "PIM per game", lower: true },
  ptg: { mine: a => div(a.pt_games, a.gp), peer: r => (r.pt_games == null ? null : r.pt_games / r.gp), basis: "share of games with a point" },
  multi: { mine: a => div(a.multi, a.gp), peer: r => (r.multi == null ? null : r.multi / r.gp), basis: "multi-point games per game" },
  gwg: { mine: a => (a.gwg == null ? null : div(a.gwg, a.gp)), peer: r => (r.gwg == null ? null : r.gwg / r.gp), basis: "game-winning goals per game" },
};
const G_RANK = {
  rec: { mine: a => div(a.w, a.gp), peer: r => r.w / r.gp, basis: "wins per game played" },
  sv: { mine: a => a.svpct, peer: r => div(r.sv, r.sa), basis: "save %" },
  gaa: { mine: a => a.gaa, peer: r => (r.toi ? r.ga * 3600 / r.toi : null), basis: "goals-against average", lower: true },
  so: { mine: a => div(a.so, a.gs), peer: r => div(r.so, r.gs), basis: "shutouts per start" },
  sa: { mine: a => div(a.sa, a.gp), peer: r => r.sa / r.gp, basis: "shots faced per game (workload)" },
  ev: { mine: a => a.evsv, peer: r => div(r.ev_sv, r.ev_sa), basis: "even-strength save %" },
  pk: { mine: a => a.ppsv, peer: r => div(r.pp_sv, r.pp_sa), basis: "penalty-kill save %" },
  qs: { mine: a => a.quality, peer: r => div(r.qs, r.gs), basis: "quality-start rate" },
};

function rankOne(mine, peerVals, lower) {
  const vals = peerVals.filter(v => v != null && Number.isFinite(v));
  if (mine == null || !Number.isFinite(mine) || vals.length < 5) return null;
  const better = vals.filter(v => (lower ? v < mine : v > mine)).length;
  const worse = vals.filter(v => (lower ? v > mine : v < mine)).length;
  const ties = vals.length - better - worse;
  const pct = Math.min(99, Math.max(1, Math.round(((worse + 0.5 * ties) / vals.length) * 100)));
  return { rank: better + 1, n: vals.length + 1, pct, tied: ties > 0, tier: TIERS.find(t => pct >= t[0]) };
}

/** Peers for ranking: same season and game type, a minimum games played, and a comparison group. */
async function rankContext(bio, isGoalie, season, type, vs) {
  let league;
  try { league = await load(`league/${season}.json`); } catch { return null; }
  const rows = objs(isGoalie ? league.goalies : league.skaters).filter(r => r.game_type === type);
  if (!rows.length) return null;
  const maxGp = Math.max(...rows.map(r => r.gp));
  const minGp = Math.max(1, Math.min(20, Math.round(maxGp * 0.25)));
  const myPos = bio.pos || rows.find(r => r.player_id === bio.id)?.pos;
  let peers = rows.filter(r => r.gp >= minGp && r.player_id !== bio.id);
  let label;
  if (isGoalie) label = "goalies";
  else if (vs === "pos" && myPos) { peers = peers.filter(r => r.pos === myPos); label = { C: "centers", L: "left wings", R: "right wings", D: "defensemen" }[myPos] || myPos; }
  else if (vs === "all") label = "skaters";
  else { const grp = posGroup(myPos); peers = peers.filter(r => posGroup(r.pos) === grp); label = grp === "D" ? "defensemen" : "forwards"; }
  return { peers, minGp, label, season, type };
}
function rankFor(ctx, defs, key, a) {
  if (!ctx || !key || !defs[key]) return null;
  const d = defs[key];
  const r = rankOne(d.mine(a), ctx.peers.map(d.peer), d.lower);
  return r && { ...r, basis: d.basis, lower: !!d.lower };
}
function rankHeader(ctx, isGoalie, vs, f) {
  if (!ctx) return `<div class="rank-bar muted">League ranks unavailable for this selection.</div>`;
  const narrowed = f.venue !== "all" || f.opp !== "all" || f.result !== "all" || f.rest !== "all" || f.month !== "all" || f.lastN || f.from || f.to || (f.seasons && f.seasons.length > 1) || !f.seasons;
  return `<div class="rank-bar">
    <span class="rank-legend">${TIERS.map(t => `<span class="t-${t[1]}"><i class="sw"></i>${t[2]}${t[0] ? ` <span class="muted">${t[0]}+</span>` : ""}</span>`).join("")}</span>
    <span class="rank-basis">Ranked vs ${seasonLabel(ctx.season)} ${ctx.type === "P" ? "playoff" : "regular-season"} ${ctx.label} with ${ctx.minGp}+ GP (${ctx.peers.length}), on per-game rates
      ${isGoalie ? "" : `<select id="rankvs" aria-label="Rank against"><option value="group" ${vs === "group" ? "selected" : ""}>Forwards / D</option><option value="pos" ${vs === "pos" ? "selected" : ""}>Same position</option><option value="all" ${vs === "all" ? "selected" : ""}>All skaters</option></select>`}
      ${narrowed ? `<span class="muted"> · this player's numbers use your filters; league numbers are full-season</span>` : ""}</span></div>`;
}
const teamName = a => TEAM_BY[a]?.name || a;
const teamLink = a => `<a href="#/team/${a}">${esc(a)}</a>`;
const playerLink = (id, name) => `<a href="#/player/${id}">${esc(name)}</a>`;
const oppCell = g => `${g.is_home ? "vs" : "@"} ${teamLink(g.opp_abbrev)}`;

// ------------------------------------------------------------------ pages
async function pageHome() {
  const season = META.current_season;
  const [league, games] = await Promise.all([load(`league/${season}.json`), load(`games/${season}.json`)]);
  const teams = objs(league.teams).filter(t => t.game_type === "R");
  const sk = objs(league.skaters).filter(s => s.game_type === "R");
  const gk = objs(league.goalies).filter(s => s.game_type === "R");
  const gl = objs(games);
  const lastDate = gl[0]?.game_date;
  const maxGp = Math.max(0, ...sk.map(s => s.gp));
  const minGp = Math.max(3, Math.round(maxGp * 0.4));

  const divs = {};
  for (const t of teams) { const d = TEAM_BY[t.team]?.division || "League"; (divs[d] ||= []).push(t); }

  app.innerHTML = h`
    <div class="head"><div><h1>${seasonLabel(season)} season</h1><div class="meta">Through ${lastDate ? fmtDate(lastDate) : "–"} · ${META.counts.games.toLocaleString()} games loaded across ${META.seasons.length} seasons</div></div></div>
    <div class="card"><h2>Latest results ${lastDate ? `<span class="muted">· ${fmtDate(lastDate)}</span>` : ""}</h2><div class="games-list">${gl.filter(g => g.game_date === lastDate).map(gameCard).join("") || '<div class="empty">No games yet.</div>'}</div></div>
    <div id="recap"></div>
    <div class="grid2" id="leaders"></div>
    <div class="card" id="home-rv"><h2>Revenge games this week <a href="#/trends" style="font-size:12px;font-weight:400;margin-left:6px">More →</a></h2><div class="muted">Loading…</div></div>
    <div class="card"><h2>Standings</h2><div class="grid2" id="standings"></div></div>`;

  recapCard($("#recap"), lastDate, gl.filter(g => g.game_date === lastDate));
  loadUpcoming().then(up => {
    const el = $("#home-rv"); if (!el) return;
    const limit = new Date(); limit.setDate(limit.getDate() + 7);
    const rows = (up?.revenge || []).filter(r => r.gp_with >= REVENGE_DEFAULT && new Date(r.date + "T12:00:00") <= limit);
    el.querySelector(".muted").outerHTML = `<div class="muted" style="font-size:12px;margin-bottom:4px">Players facing a team they played ${REVENGE_DEFAULT}+ games for.</div>` + revengeList(rows.slice(0, 10));
  });
  const L = $("#leaders");
  const leader = (title, rows, valFmt, sub) => `<div class="card"><h2>${title}</h2><table><tbody>${rows.map((r, i) =>
    `<tr><td class="muted" style="width:24px">${i + 1}</td><td>${playerLink(r.player_id, r.name)} <span class="muted">${r.team}</span></td><td class="n"><b>${valFmt(r)}</b></td>${sub ? `<td class="n muted">${sub(r)}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
  const top = (arr, f, n = 10) => [...arr].sort((a, b) => f(b) - f(a)).slice(0, n);
  L.innerHTML =
    leader("Points", top(sk, s => s.p), s => s.p, s => `${s.gp} GP`) +
    leader("Goals", top(sk, s => s.g), s => s.g, s => `${s.gp} GP`) +
    `<div class="card"><h2>Hottest right now <a href="#/trends" style="font-size:12px;font-weight:400;margin-left:6px">All trends →</a></h2><ul class="trend-list">${Object.entries(league.form?.skaters || {})
      .map(([id, f]) => ({ id, ...f, r: sk.find(x => String(x.player_id) === id) })).filter(x => x.r && x.score >= 0.9).sort((a, b) => b.score - a.score).slice(0, 8)
      .map(x => `<li><span>${playerLink(x.id, x.r.name)} <span class="muted">${x.r.team}</span></span><span>${formBadge(x.status)}</span><span class="why">${esc(x.reasons[0])}</span></li>`).join("") || '<li class="muted">Nobody is well above expectation right now.</li>'}</ul></div>` +
    leader(`Save % <span class="muted">(min ${Math.max(3, Math.round(Math.max(0, ...gk.map(g => g.gp)) * 0.4))} GP)</span>`,
      top(gk.filter(g => g.gp >= Math.max(3, Math.round(Math.max(0, ...gk.map(x => x.gp)) * 0.4))), g => g.sv / g.sa), g => fmtSv(g.sv / g.sa), g => `${g.gp} GP`);

  const S = $("#standings");
  S.innerHTML = Object.keys(divs).sort().map(d => {
    const rows = divs[d].sort((a, b) => b.pts - a.pts || a.gp - b.gp);
    return `<div><h3>${esc(d)}</h3><table class="standings"><thead><tr><th>Team</th><th class="n">GP</th><th class="n">W</th><th class="n">L</th><th class="n">OTL</th><th class="n">PTS</th><th class="n">P%</th><th class="n">GF</th><th class="n">GA</th><th class="n">Diff</th><th class="n">L10</th></tr></thead><tbody>${rows.map(t =>
      `<tr><td>${teamLink(t.team)} <span class="muted">${esc(TEAM_BY[t.team]?.common_name || "")}</span></td><td class="n">${t.gp}</td><td class="n">${t.w}</td><td class="n">${t.l}</td><td class="n">${t.otl}</td><td class="n"><b>${t.pts}</b></td><td class="n">${fmtSv(t.pts / (2 * t.gp))}</td><td class="n">${t.gf}</td><td class="n">${t.ga}</td><td class="n">${fmtSigned(t.gf - t.ga)}</td><td class="n">${t.w10}-${t.l10}-${t.otl10}</td></tr>`).join("")}</tbody></table></div>`;
  }).join("");
}

function gameCard(g) {
  const awayWin = g.away_score > g.home_score;
  return `<a class="game-card" href="#/game/${g.game_id}">
    <div class="line ${awayWin ? "win" : ""}"><span>${esc(g.away_abbrev)}</span><span class="num">${g.away_score}</span></div>
    <div class="line ${!awayWin ? "win" : ""}"><span>${esc(g.home_abbrev)}</span><span class="num">${g.home_score}</span></div>
    <div class="sub">${shortDate(g.game_date)}${g.last_period_type && g.last_period_type !== "REG" ? " · Final/" + g.last_period_type : " · Final"}${g.game_type === "P" ? " · Playoffs" : ""} · SOG ${g.away_sog ?? "–"}–${g.home_sog ?? "–"}</div></a>`;
}

// ---------- player
const SKATER_METRICS = {
  points: ["Points", g => g.points], goals: ["Goals", g => g.goals], assists: ["Assists", g => g.assists],
  sog: ["Shots on goal", g => g.sog], toi: ["Time on ice (min)", g => g.toi_sec / 60], ppp: ["Power-play points", g => g.ppp],
  hits: ["Hits", g => g.hits], blocks: ["Blocked shots", g => g.blocks], pm: ["Plus/minus", g => g.plus_minus], pim: ["Penalty minutes", g => g.pim],
  shifts: ["Shifts", g => g.shifts],
};
const GOALIE_METRICS = {
  svpct: ["Save %", null], ga: ["Goals against", g => g.goals_against], sa: ["Shots against", g => g.shots_against], saves: ["Saves", g => g.saves],
};

async function pagePlayer(id) {
  const doc = await load(`players/${id}.json`);
  const bio = doc.bio;
  const isGoalie = !!doc.goalie && !doc.skater;
  const games = objs(isGoalie ? doc.goalie : doc.skater);
  const seasons = [...new Set(games.map(g => g.season))].sort();
  const latest = seasons[seasons.length - 1];
  const f = DEFAULT_FILTER(); f.seasons = [latest]; f._defaultSeasons = [latest];
  const opps = [...new Set(games.map(g => g.opp_abbrev))].sort();
  const age = bio.birth_date ? Math.floor((Date.now() - new Date(bio.birth_date)) / 3.15576e10) : null;
  const team = bio.current_team || games[games.length - 1]?.team_abbrev;
  const teamsPlayed = [...new Set(games.map(g => g.team_abbrev))];

  app.innerHTML = h`
    <div class="head"><div>
      <h1>${esc(bio.name)} ${bio.sweater ? `<span class="muted">#${bio.sweater}</span>` : ""}</h1>
      <div class="meta">${esc(bio.pos || "")} · ${team ? teamLink(team) + " " + esc(TEAM_BY[team]?.common_name || "") : ""}
        ${age != null ? ` · Age ${age}` : ""}${bio.shoots ? ` · ${isGoalie ? "Catches" : "Shoots"} ${bio.shoots}` : ""}
        ${bio.height_in ? ` · ${Math.floor(bio.height_in / 12)}'${bio.height_in % 12}"` : ""}${bio.weight_lb ? `, ${bio.weight_lb} lb` : ""}
        ${bio.birth_country ? ` · ${esc(bio.birth_country)}` : ""}</div>
      <div class="meta">${games.length} games loaded · ${seasons.map(seasonLabel).join(", ")}${teamsPlayed.length > 1 ? " · Teams: " + teamsPlayed.map(teamLink).join(", ") : ""}</div>
      <div class="meta" id="nextgame"></div>
    </div><div><a class="btn" href="#/compare?a=${id}">Compare with…</a></div></div>
    <div id="form"></div><div id="fbar"></div><div id="body"></div>`;
  const former = (doc.former_teams || []);
  loadUpcoming().then(up => {
    const el = $("#nextgame"); if (!el || !up || !team) return;
    const [ng] = nextGamesFor(up, team, 1);
    if (!ng) return;
    const opp = ng.home_abbrev === team ? ng.away_abbrev : ng.home_abbrev;
    const f = former.find(x => x.team === opp);
    el.innerHTML = `Next game: <b>${fmtGameTime(ng.game_date, ng.start_utc)}</b> ${ng.home_abbrev === team ? "vs" : "@"} ${teamLink(opp)}${f && f.gp >= REVENGE_DEFAULT ? " " + revengeBadge(f.gp, opp, f.last_season) : ""}`;
  });
  formFor(isGoalie ? "goalies" : "skaters", id, latest).then(({ f: fm, asOf }) => { const el = $("#form"); if (el) el.innerHTML = formCard(fm, asOf, latest, isGoalie ? "goalie" : "skater"); });

  const body = $("#body");
  let metric = isGoalie ? "svpct" : "points", win = 10, rankVs = "group";
  const rankSeason = () => (f.seasons?.length ? Math.max(...f.seasons) : latest);
  let muOpp = null;
  const mostPlayed = () => Object.entries(groupBy(games, g => g.opp_abbrev)).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const drawMatchup = () => {
    const el = $("#matchup"); if (!el) return;
    const opp = muOpp || mostPlayed();
    if (!opp) return;
    matchupCard(el, games.filter(g => g.game_type === "R"), isGoalie, opp, opps, v => { muOpp = v; drawMatchup(); });
  };
  loadUpcoming().then(up => {
    if (!up || !team || muOpp) return;
    const [ng] = nextGamesFor(up, team, 1);
    if (ng) { muOpp = ng.home_abbrev === team ? ng.away_abbrev : ng.home_abbrev; drawMatchup(); }
  });
  const render = async () => {
    const fg = applyFilter(games, f, "team_result");
    $(".filter-note").textContent = `${fg.length} of ${games.length} games`;
    const careerRows = Object.entries(groupBy(games, g => g.season + "|" + g.game_type + "|" + g.team_abbrev)).map(([k, gs]) => {
      const [s, t, tm] = k.split("|"); return { season: +s, type: t, team: tm, ...(isGoalie ? aggGoalie(gs) : aggSkater(gs)) };
    });
    if (isGoalie) {
      const a = aggGoalie(fg);
      const ctx = await rankContext(bio, true, rankSeason(), f.type === "P" ? "P" : "R", rankVs);
      const T = items => tiles(items.map(([k, v, s, key]) => [k, v, s, key, rankFor(ctx, G_RANK, key, a)]));
      body.innerHTML = h`
        ${rankHeader(ctx, true, rankVs, f)}
        ${T([["GP", a.gp, `${a.gs} starts`], ["Record", recordStr(a), fmtPct(div(a.w, a.gp), 0) + " wins", "rec"], ["SV%", fmtSv(a.svpct), "", "sv"], ["GAA", fmt(a.gaa, 2), "", "gaa"], ["Shutouts", a.so, "", "so"],
          ["Shots against", a.sa, fmt(div(a.sa, a.gp), 1) + "/GP", "sa"], ["EV SV%", fmtSv(a.evsv), "", "ev"], ["PK SV%", fmtSv(a.ppsv), "", "pk"], ["Quality starts", fmtPct(a.quality, 0), "", "qs"]])}
        <div class="card" style="margin-top:16px"><div class="chart-controls"><h2 style="margin:0">Trend</h2>
          <select id="metric">${Object.entries(GOALIE_METRICS).map(([k, [l]]) => `<option value="${k}" ${k === metric ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select id="win">${[3, 5, 10, 20].map(w => `<option value="${w}" ${w === win ? "selected" : ""}>${w}-game rolling</option>`).join("")}</select></div>
          <div class="legend" id="tleg"></div><div class="chart" id="trend"></div></div>
        <div class="card"><h2>Splits</h2><div id="splits"></div></div>
        <div class="grid2"><div>${patternsCard(fg, true)}</div><div id="matchup"></div></div>
        <div class="card"><h2>Game log</h2><div id="log"></div></div>
        <div class="card"><h2>By season</h2><div id="career"></div></div>`;
      drawMatchup();
      drawTrendGoalie(fg, metric, win);
      splitsBlock($("#splits"), fg, "G", withFormerSplit(commonSplits("team_result"), former));
      sortTable($("#log"), [...fg].reverse(), [
        { k: "game_date", label: "Date", html: r => `<a href="#/game/${r.game_id}">${shortDate(r.game_date)}</a> <span class="muted">${String(r.season).slice(2, 4)}-${String(r.season).slice(6)}</span>`, sortVal: r => r.game_date },
        { k: "opp_abbrev", label: "Opp", html: oppCell }, { k: "decision", label: "Dec" }, { k: "started", label: "GS", fmt: v => (v ? "✓" : "") },
        { k: "shots_against", label: "SA", n: 1 }, { k: "saves", label: "SV", n: 1 }, { k: "goals_against", label: "GA", n: 1 },
        { k: "svp", label: "SV%", n: 1, html: r => fmtSv(div(r.saves, r.shots_against)), sortVal: r => div(r.saves, r.shots_against), csv: r => fmtSv(div(r.saves, r.shots_against)) },
        { k: "ev", label: "EV", n: 1, html: r => `${r.ev_saves ?? "–"}/${r.ev_shots ?? "–"}` }, { k: "pp", label: "PK", n: 1, html: r => `${r.pp_saves ?? "–"}/${r.pp_shots ?? "–"}` },
        { k: "toi_sec", label: "TOI", n: 1, fmt: fmtToi }, { k: "rest_days", label: "Rest", n: 1 }], { sortKey: "game_date", csvName: `${bio.name}-gamelog` });
      sortTable($("#career"), careerRows, [{ k: "season", label: "Season", fmt: seasonLabel }, { k: "type", label: "Type", fmt: v => (v === "P" ? "Playoffs" : "Regular") },
        { k: "team", label: "Team", html: r => teamLink(r.team) }, ...statCols("G")], { sortKey: "season", csvName: `${bio.name}-seasons` });
    } else {
      const a = aggSkater(fg);
      const ctx = await rankContext(bio, false, rankSeason(), f.type === "P" ? "P" : "R", rankVs);
      const T = items => tiles(items.map(([k, v, s, key]) => [k, v, s, key, rankFor(ctx, SK_RANK, key, a)]));
      body.innerHTML = h`
        ${rankHeader(ctx, false, rankVs, f)}
        ${T([["GP", a.gp], ["Goals", a.g, fmt(a.gpg, 2) + "/GP", "g"], ["Assists", a.a, fmt(div(a.a, a.gp), 2) + "/GP", "a"], ["Points", a.p, fmt(a.ppg_rate, 2) + "/GP", "p"],
          ["Shots", a.sog, fmt(a.sog_rate, 2) + "/GP", "sog"], ["Shooting %", fmtPct(a.shpct), "", "sh"], ["PP points", a.ppp ?? "–", `${a.ppgoals} PPG`, "ppp"], ["+/-", fmtSigned(a.pm), "", "pm"],
          ["TOI/GP", fmtToi(a.toi), "", "toi"], ["Hits", a.hits, fmt(div(a.hits, a.gp), 2) + "/GP", "hits"], ["Blocks", a.blk, fmt(div(a.blk, a.gp), 2) + "/GP", "blk"], ["PIM", a.pim, "", "pim"],
          ["Point games", a.pt_games, fmtPct(div(a.pt_games, a.gp), 0), "ptg"], ["Multi-pt games", a.multi, "", "multi"], ["GWG", a.gwg ?? "–", "", "gwg"], ["FO%", a.fo != null && a.fo > 0 ? fmtPct(a.fo) : "–"]])}
        <div class="grid2" style="margin-top:16px">
          <div class="card"><div class="chart-controls"><h2 style="margin:0">Trend</h2>
            <select id="metric">${Object.entries(SKATER_METRICS).map(([k, [l]]) => `<option value="${k}" ${k === metric ? "selected" : ""}>${l}</option>`).join("")}</select>
            <select id="win">${[3, 5, 10, 20].map(w => `<option value="${w}" ${w === win ? "selected" : ""}>${w}-game rolling</option>`).join("")}</select></div>
            <div class="legend" id="tleg"></div><div class="chart" id="trend"></div></div>
          <div class="card"><h2>League percentiles <span class="muted" id="pct-note"></span></h2><div id="pct"></div></div>
        </div>
        <div class="card"><h2>Splits</h2><div id="splits"></div></div>
        <div class="grid2"><div>${patternsCard(fg, false)}</div><div id="matchup"></div></div>
        <div class="card"><h2>Game log</h2><div id="log"></div></div>
        <div class="card"><h2>By season</h2><div id="career"></div></div>`;
      drawMatchup();
      drawTrendSkater(fg, metric, win);
      percentiles(bio, f.seasons?.length === 1 ? f.seasons[0] : latest, f.type === "P" ? "P" : "R");
      splitsBlock($("#splits"), fg, "S", withFormerSplit(commonSplits("team_result"), former));
      sortTable($("#log"), [...fg].reverse(), [
        { k: "game_date", label: "Date", html: r => `<a href="#/game/${r.game_id}">${shortDate(r.game_date)}</a> <span class="muted">${String(r.season).slice(2, 4)}-${String(r.season).slice(6)}</span>`, sortVal: r => r.game_date, csv: r => r.game_date },
        { k: "opp_abbrev", label: "Opp", html: oppCell, csv: r => (r.is_home ? "vs " : "@ ") + r.opp_abbrev },
        { k: "team_result", label: "Result", html: r => `${r.team_result || "–"} ${r.team_gf ?? ""}-${r.team_ga ?? ""}`, csv: r => `${r.team_result} ${r.team_gf}-${r.team_ga}` },
        { k: "goals", label: "G", n: 1 }, { k: "assists", label: "A", n: 1 }, { k: "points", label: "P", n: 1 }, { k: "plus_minus", label: "+/-", n: 1, fmt: v => fmtSigned(v) },
        { k: "sog", label: "SOG", n: 1 }, { k: "ppp", label: "PPP", n: 1 }, { k: "hits", label: "Hits", n: 1 }, { k: "blocks", label: "Blk", n: 1 },
        { k: "pim", label: "PIM", n: 1 }, { k: "giveaways", label: "GV", n: 1 }, { k: "takeaways", label: "TK", n: 1 }, { k: "toi_sec", label: "TOI", n: 1, fmt: fmtToi },
        { k: "shifts", label: "Shifts", n: 1 }, { k: "faceoff_pct", label: "FO%", n: 1, fmt: (v, r) => (r.position === "C" && v != null ? fmtPct(v, 0) : "–") },
        { k: "rest_days", label: "Rest", n: 1 }], { sortKey: "game_date", csvName: `${bio.name}-gamelog` });
      sortTable($("#career"), careerRows, [{ k: "season", label: "Season", fmt: seasonLabel }, { k: "type", label: "Type", fmt: v => (v === "P" ? "Playoffs" : "Regular") },
        { k: "team", label: "Team", html: r => teamLink(r.team) }, ...statCols("S")], { sortKey: "season", csvName: `${bio.name}-seasons` });
    }
    $("#metric").onchange = e => { metric = e.target.value; render(); };
    $("#win").onchange = e => { win = +e.target.value; render(); };
    const rv = $("#rankvs"); if (rv) rv.onchange = e => { rankVs = e.target.value; render(); };
  };
  $("#fbar").appendChild(filterBar(f, { seasons, opps, onChange: render }));
  render();

  function drawTrendSkater(fg, m, w) {
    const [label, fn] = SKATER_METRICS[m];
    const vals = fg.map(fn);
    const avg = vals.length ? vals.reduce((a, b) => a + (b || 0), 0) / vals.length : null;
    const roll = rolling(vals, w);
    $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>${w}-game average</span><span><i style="background:var(--series-1);opacity:.35;height:6px;width:6px;border-radius:3px"></i>Single game</span><span><i class="dash"></i>Filtered average (${fmt(avg, m === "toi" ? 1 : 2)})</span>`;
    lineChart($("#trend"), {
      title: label, series: [{ name: label, color: "var(--series-1)", values: roll, dots: vals }], ref: { value: avg },
      xLabels: fg.map(g => shortDate(g.game_date)), zeroBase: m !== "pm",
      tipHtml: i => { const g = fg[i]; return `<b>${fmtDate(g.game_date)} ${g.is_home ? "vs" : "@"} ${g.opp_abbrev}</b><div class="row"><span>${label}</span><span>${fmt(vals[i], m === "toi" ? 1 : 0)}</span></div><div class="row"><span>${w}-game avg</span><span>${fmt(roll[i], 2)}</span></div><div class="row"><span>Line</span><span>${g.goals}G ${g.assists}A ${g.sog} SOG</span></div><div class="row"><span>Team</span><span>${g.team_result || ""} ${g.team_gf}-${g.team_ga}</span></div>`; },
    });
  }
  function drawTrendGoalie(fg, m, w) {
    let vals, roll, label, avg;
    if (m === "svpct") {
      label = "Save %"; vals = fg.map(g => div(g.saves, g.shots_against));
      roll = rollingRatio(fg.map(g => g.saves), fg.map(g => g.shots_against), w);
      avg = div(sum(fg, "saves"), sum(fg, "shots_against"));
    } else {
      const [l, fn] = GOALIE_METRICS[m]; label = l; vals = fg.map(fn); roll = rolling(vals, w);
      avg = vals.length ? vals.reduce((a, b) => a + (b || 0), 0) / vals.length : null;
    }
    const yf = m === "svpct" ? fmtSv : v => fmt(v, 1);
    $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>${w}-game ${m === "svpct" ? "(shot-weighted)" : "average"}</span><span><i class="dash"></i>Filtered average (${yf(avg)})</span>`;
    lineChart($("#trend"), {
      title: label, series: [{ name: label, color: "var(--series-1)", values: roll, dots: vals }], ref: { value: avg }, yFmt: yf,
      xLabels: fg.map(g => shortDate(g.game_date)), zeroBase: m !== "svpct",
      tipHtml: i => { const g = fg[i]; return `<b>${fmtDate(g.game_date)} ${g.is_home ? "vs" : "@"} ${g.opp_abbrev}</b><div class="row"><span>Saves</span><span>${g.saves}/${g.shots_against}</span></div><div class="row"><span>${label}</span><span>${yf(vals[i])}</span></div><div class="row"><span>${w}-game</span><span>${yf(roll[i])}</span></div><div class="row"><span>Decision</span><span>${g.decision || "–"}</span></div>`; },
    });
  }
}
function groupBy(arr, fn) { const o = {}; for (const x of arr) (o[fn(x)] ||= []).push(x); return o; }

async function percentiles(bio, season, type) {
  const el = $("#pct"); if (!el) return;
  let league;
  try { league = await load(`league/${season}.json`); } catch { el.innerHTML = '<div class="empty">No league data.</div>'; return; }
  const sk = objs(league.skaters).filter(s => s.game_type === type);
  const me = sk.find(s => s.player_id === bio.id);
  if (!me) { el.innerHTML = `<div class="empty">No ${type === "P" ? "playoff" : "regular-season"} games in ${seasonLabel(season)}.</div>`; return; }
  const grp = posGroup(me.pos);
  const maxGp = Math.max(...sk.map(s => s.gp));
  const minGp = Math.max(1, Math.min(20, Math.round(maxGp * 0.25)));
  const peers = sk.filter(s => posGroup(s.pos) === grp && s.gp >= minGp);
  $("#pct-note").textContent = `· ${seasonLabel(season)} · vs ${peers.length} ${grp === "D" ? "defensemen" : "forwards"} (min ${minGp} GP)`;
  const stats = [
    ["Points/GP", s => s.p / s.gp, v => fmt(v, 2)], ["Goals/GP", s => s.g / s.gp, v => fmt(v, 2)], ["Shots/GP", s => s.sog / s.gp, v => fmt(v, 2)],
    ["PP points/GP", s => (s.ppp ?? 0) / s.gp, v => fmt(v, 2)], ["TOI/GP", s => s.toi / s.gp, fmtToi], ["Hits/GP", s => s.hits / s.gp, v => fmt(v, 2)],
    ["Blocks/GP", s => s.blk / s.gp, v => fmt(v, 2)], ["Last 10 P/GP", s => (s.gp10 ? s.p10 / s.gp10 : 0), v => fmt(v, 2)],
  ];
  el.innerHTML = stats.map(([label, fn, f]) => {
    const v = fn(me), arr = peers.map(fn);
    const pct = arr.length ? Math.round((arr.filter(x => x < v).length + 0.5 * arr.filter(x => x === v).length) / arr.length * 100) : null;
    return `<div class="pct-row"><span class="sec">${label}</span><div class="meter" title="${pct}th percentile"><div class="t-${pct == null ? "avg" : TIERS.find(t => pct >= t[0])[1]}" style="width:${pct ?? 0}%"></div></div><span class="num">${f(v)}</span><span class="num"><b>${pct ?? "–"}</b></span></div>`;
  }).join("") + `<div class="muted" style="font-size:12px;margin-top:6px">${me.gp < minGp ? "Below the games-played minimum — read with care. " : ""}Right column = percentile rank (100 = best in group).</div>`;
}


// ------------------------------------------------------------------ upcoming games & revenge games
const REVENGE_DEFAULT = 80;
const fmtGameTime = (date, startUtc) => {
  const d = new Date(date + "T12:00:00");
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const t = startUtc ? new Date(startUtc).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  return t ? `${day} · ${t}` : day;
};
async function loadUpcoming() { try { return await load("upcoming.json"); } catch { return null; } }
const nextGamesFor = (up, team, n = 5) => objs(up?.games).filter(g => g.home_abbrev === team || g.away_abbrev === team).slice(0, n);
const revengeBadge = (gp, team, last) => `<span class="form f-warming" title="Played ${gp} NHL games for ${esc(team)}${last ? " (last in " + seasonLabel(last) + ")" : ""}">↩ Revenge game · ${gp} GP with ${esc(team)}</span>`;
const vsLine = v => (!v ? "" : v.svpct !== undefined ? `${fmtSv(v.svpct)} SV% in ${v.gp} GP` : `${v.g} G, ${v.a} A, ${v.p} P in ${v.gp} GP`);
function revengeList(rows, { showDate = true } = {}) {
  if (!rows.length) return `<div class="muted">None in this window.</div>`;
  return `<ul class="trend-list">${rows.map(r => `<li><span>${playerLink(r.player_id, r.name)} <span class="muted">${esc(r.pos || "")} · ${esc(r.team)}</span>
    ${r.is_home ? "vs" : "@"} <b>${teamLink(r.opp)}</b></span><span class="muted">${showDate ? fmtGameTime(r.date, r.start_utc) : ""}</span>
    <span class="why">${r.gp_with} games with ${esc(r.opp)}${r.last_season_with ? " (last in " + seasonLabel(r.last_season_with) + ")" : ""}${r.vs ? " · vs them since 2021-22: " + vsLine(r.vs) : ""}</span></li>`).join("")}</ul>`;
}

// ------------------------------------------------------------------ scoring patterns & matchups (player page)
/** After a game where `hit(g)` happened, how often does it happen again next game? Consecutive games within a season. */
function followThrough(games, hit) {
  let ah = 0, ahn = 0, am = 0, amn = 0, longest = 0, run = 0, pairs = 0, both = 0;
  for (let i = 0; i < games.length; i++) {
    const h = hit(games[i]);
    run = h ? run + 1 : 0; longest = Math.max(longest, run);
    if (i > 0 && games[i - 1].season === games[i].season) {
      const p = hit(games[i - 1]); pairs++;
      if (p) { ahn++; if (h) { ah++; both++; } } else { amn++; if (h) am++; }
    }
  }
  const rate = games.length ? games.filter(hit).length / games.length : null;
  let current = 0; for (let i = games.length - 1; i >= 0 && hit(games[i]); i--) current++;
  return { rate, afterHit: div(ah, ahn), afterMiss: div(am, amn), ahn, amn, longest, current, b2bShare: div(both, pairs) };
}
function patternVerdict(ft, what) {
  if (ft.ahn < 15 || ft.amn < 15) return `<span class="muted">Not enough games yet to judge.</span>`;
  const d = ft.afterHit - ft.afterMiss;
  if (d >= 0.12) return `<b>Streaky</b> — ${what} tend to come in bunches`;
  if (d <= -0.12) return `<b>Bounce-back</b> — more likely after a game without one`;
  return `<b>Even</b> — last game doesn't predict the next`;
}
function patternsCard(fg, isGoalie) {
  const rowsDef = isGoalie
    ? [["Quality start (.900+)", g => g.shots_against > 0 && g.saves / g.shots_against >= 0.9, "quality starts"],
       ["Win", g => g.decision === "W", "wins"]]
    : [["Point", g => g.points > 0, "points"], ["Goal", g => g.goals > 0, "goals"], ["Multi-point game", g => g.points >= 2, "multi-point games"],
       ["3+ shots", g => g.sog >= 3, "shot games"]];
  const rows = rowsDef.map(([label, fn, what]) => ({ label, ft: followThrough(fg, fn), what }));
  return `<div class="card"><h2>Scoring patterns <span class="muted" style="font-weight:400">· consecutive games in your filter</span></h2>
    <table><thead><tr><th></th><th class="n">Any game</th><th class="n">Right after one</th><th class="n">After a game without</th><th class="n">Back-to-back games</th><th class="n">Longest run</th><th class="n">Current run</th></tr></thead><tbody>
    ${rows.map(({ label, ft }) => `<tr><td>${label}</td><td class="n">${fmtPct(ft.rate, 0)}</td>
      <td class="n ${ft.ahn >= 15 && ft.afterHit - ft.rate >= 0.1 ? "hot" : ""}">${fmtPct(ft.afterHit, 0)} <span class="muted">(${ft.ahn})</span></td>
      <td class="n">${fmtPct(ft.afterMiss, 0)} <span class="muted">(${ft.amn})</span></td>
      <td class="n" title="Share of consecutive game pairs where both games had one">${fmtPct(ft.b2bShare, 0)}</td><td class="n">${ft.longest}</td><td class="n">${ft.current}</td></tr>`).join("")}
    </tbody></table>
    <ul style="margin:8px 0 0;padding-left:18px;color:var(--text-secondary);font-size:13px">${rows.slice(0, 2).map(r => `<li>${r.label}s: ${patternVerdict(r.ft, r.what)}</li>`).join("")}</ul>
    <div class="muted" style="font-size:12px;margin-top:6px">"Right after one" = chance of doing it again the very next game. Numbers in parentheses are sample sizes.</div></div>`;
}
function matchupCard(el, games, isGoalie, opp, opps, onPick) {
  const vs = games.filter(g => g.opp_abbrev === opp), rest = games.filter(g => g.opp_abbrev !== opp);
  if (!opps.includes(opp)) opps = [opp, ...opps];
  const pick = `<select id="mu-opp">${opps.map(o => `<option value="${o}" ${o === opp ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  let body;
  if (!vs.length) body = `<div class="muted">No games against ${esc(opp)} since 2021-22.</div>`;
  else if (isGoalie) {
    const a = aggGoalie(vs), b = aggGoalie(rest);
    body = tiles([["GP vs " + opp, a.gp, recordStr(a)], ["SV%", fmtSv(a.svpct), "others " + fmtSv(b.svpct)], ["GAA", fmt(a.gaa, 2), "others " + fmt(b.gaa, 2)]]);
  } else {
    const a = aggSkater(vs), b = aggSkater(rest);
    const z = (() => { const n1 = a.gp, n2 = b.gp; if (!n1 || !n2) return 0; const pool = (a.p + b.p) / (n1 + n2); return (a.p / n1 - b.p / n2) / Math.sqrt(Math.max(pool, 1e-9) * (1 / n1 + 1 / n2)); })();
    const conf = Math.abs(z) >= 2.5 ? "strong" : Math.abs(z) >= 1.5 ? "moderate" : "weak (could be chance)";
    body = tiles([["GP vs " + opp, a.gp], ["Points", a.p, fmt(a.ppg_rate, 2) + "/GP"], ["Others", fmt(b.ppg_rate, 2) + "/GP", "vs everyone else"],
      ["Goals", a.g, fmt(a.gpg, 2) + "/GP"], ["Shots/GP", fmt(a.sog_rate, 1), "others " + fmt(b.sog_rate, 1)]])
      + `<div class="sec" style="margin-top:8px;font-size:13px">${a.ppg_rate > b.ppg_rate ? "Better" : "Worse"} against ${esc(opp)} by ${fmt(Math.abs(a.ppg_rate - b.ppg_rate), 2)} points per game — evidence: <b>${conf}</b>.</div>`;
  }
  const last = [...vs].reverse().slice(0, 5);
  el.innerHTML = `<div class="card"><div class="chart-controls"><h2 style="margin:0">Matchup</h2>${pick}<span class="muted">regular season since 2021-22</span></div>${body}
    ${last.length ? `<table style="margin-top:10px"><thead><tr><th>Last meetings</th><th class="n">${isGoalie ? "SV" : "G-A-P"}</th><th class="n">${isGoalie ? "SV%" : "SOG"}</th><th>Result</th></tr></thead><tbody>${last.map(g =>
      `<tr><td><a href="#/game/${g.game_id}">${shortDate(g.game_date)} ${String(g.season).slice(2, 4)}-${String(g.season).slice(6)}</a> ${g.is_home ? "vs" : "@"} ${g.opp_abbrev}</td><td class="n">${isGoalie ? `${g.saves}/${g.shots_against}` : `${g.goals}-${g.assists}-${g.points}`}</td><td class="n">${isGoalie ? fmtSv(div(g.saves, g.shots_against)) : g.sog}</td><td>${g.team_result || ""}</td></tr>`).join("")}</tbody></table>` : ""}</div>`;
  el.querySelector("#mu-opp").onchange = e => onPick(e.target.value);
}

// ------------------------------------------------------------------ form (hot / cold)
const FORM = { hot: ["🔥", "Hot"], warming: ["▲", "Warming"], steady: ["–", "Steady"], cooling: ["▼", "Cooling"], cold: ["❄", "Cold"] };
const FORM_ORDER = { hot: 4, warming: 3, steady: 2, cooling: 1, cold: 0 };
const FLAG_TEXT = { regression_risk: "Likely to cool", buy_low: "Due to heat up", role_up: "Role ↑", role_down: "Role ↓" };
const formBadge = (st, cls = "") => (st ? `<span class="form f-${st} ${cls}">${FORM[st][0]} ${FORM[st][1]}</span>` : `<span class="muted">–</span>`);
const flagChips = flags => (flags || []).map(f => `<span class="flag">${FLAG_TEXT[f] || f}</span>`).join("");
async function formFor(kind, id, season) {
  try { const lg = await load(`league/${season}.json`); return { f: lg.form?.[kind]?.[String(id)], asOf: lg.form?.as_of }; } catch { return {}; }
}
function formCard(fm, asOf, season, what) {
  if (!fm) return `<div class="card"><h2>Current form</h2><div class="muted">Not enough games in ${seasonLabel(season)} yet to judge form (needs about 8${what === "goalie" ? " appearances (5)" : ""}).</div></div>`;
  const current = season === META.current_season;
  return `<div class="card"><h2>${current ? "Current form" : "Form at season's end"} <span class="muted">· as of ${fmtDate(fm.last_game || asOf)}</span></h2>
    <div class="form-card"><div>${formBadge(fm.status, "big")}<div class="muted" style="font-size:11px;margin-top:6px" title="How unusual the recent stretch is vs expectation (±1.8 = hot/cold)">score ${fmtSigned(fm.score, 1)}</div></div>
    <div><ul>${fm.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>${fm.flags?.length ? `<div style="margin-top:6px">${flagChips(fm.flags)}</div>` : ""}</div></div></div>`;
}

// ---------- team
const T_RANK = {
  rec: { mine: a => a.ptspct, peer: r => r.pts / (2 * r.gp), basis: "points %" },
  gf: { mine: a => a.gfpg, peer: r => r.gf / r.gp, basis: "goals for per game" },
  ga: { mine: a => a.gapg, peer: r => r.ga / r.gp, basis: "goals against per game", lower: true },
  diff: { mine: a => div(a.diff, a.gp), peer: r => (r.gf - r.ga) / r.gp, basis: "goal differential per game" },
  sf: { mine: a => a.sfpg, peer: r => r.sf / r.gp, basis: "shots for per game" },
  sa: { mine: a => a.sapg, peer: r => r.sa / r.gp, basis: "shots against per game", lower: true },
  sfpct: { mine: a => a.sfpct, peer: r => div(r.sf, r.sf + r.sa), basis: "shot share" },
  pp: { mine: a => a.pp, peer: r => div(r.ppg, r.ppo), basis: "power-play %" },
  pk: { mine: a => a.pk, peer: r => (r.pko ? 1 - r.pkga / r.pko : null), basis: "penalty-kill %" },
  sh: { mine: a => a.shpct, peer: r => div(r.gf, r.sf), basis: "shooting %" },
  sv: { mine: a => a.svpct, peer: r => (r.sa ? 1 - r.ga / r.sa : null), basis: "save %" },
};
async function teamRankContext(abbr, season, type) {
  let league;
  try { league = await load(`league/${season}.json`); } catch { return null; }
  const peers = objs(league.teams).filter(r => r.game_type === type && r.team !== abbr && r.gp > 0);
  return peers.length >= 5 ? { peers, season, type } : null;
}
function teamRankHeader(ctx, f) {
  if (!ctx) return `<div class="rank-bar muted">League ranks unavailable for this selection.</div>`;
  const narrowed = f.venue !== "all" || f.opp !== "all" || f.result !== "all" || f.rest !== "all" || f.month !== "all" || f.lastN || f.from || f.to || (f.seasons && f.seasons.length > 1) || !f.seasons;
  return `<div class="rank-bar"><span class="rank-legend">${TIERS.map(t => `<span class="t-${t[1]}"><i class="sw"></i>${t[2]}${t[0] ? ` <span class="muted">${t[0]}+</span>` : ""}</span>`).join("")}</span>
    <span class="rank-basis">Ranked vs all ${ctx.peers.length + 1} teams, ${seasonLabel(ctx.season)} ${ctx.type === "P" ? "playoffs" : "regular season"}, per-game rates${narrowed ? `<span class="muted"> · this team's numbers use your filters; league numbers are full-season</span>` : ""}</span></div>`;
}

async function pageTeam(abbr) {
  const doc = await load(`teams/${abbr}.json`);
  const games = objs(doc.games);
  const seasons = [...new Set(games.map(g => g.season))].sort();
  const latest = seasons[seasons.length - 1];
  const f = DEFAULT_FILTER(); f.seasons = [latest]; f._defaultSeasons = [latest];
  const opps = [...new Set(games.map(g => g.opp_abbrev))].sort();
  const t = TEAM_BY[abbr] || {};
  const skaters = objs(doc.skaters), goalies = objs(doc.goalies);
  let metric = "goals", win = 10, rosterSeasonsKey = null;

  app.innerHTML = h`
    <div class="head"><div><h1>${esc(t.name || abbr)}</h1><div class="meta">${t.division ? esc(t.division) + " Division · " + esc(t.conference) + " Conference · " : ""}${games.length} games loaded</div></div>
      <div><a class="btn" href="#/compare?ta=${abbr}">Compare with…</a></div></div>
    <div class="grid2"><div id="form"></div><div id="upcoming"></div></div><div id="fbar"></div><div id="body"></div>`;
  loadUpcoming().then(up => {
    const el = $("#upcoming"); if (!el || !up) return;
    const ng = nextGamesFor(up, abbr, 6);
    const rv = (up.revenge || []).filter(r => r.gp_with >= REVENGE_DEFAULT && (r.team === abbr || r.opp === abbr));
    el.innerHTML = `<div class="card"><h2>Upcoming</h2>${ng.length ? `<table><tbody>${ng.map(g => {
      const opp = g.home_abbrev === abbr ? g.away_abbrev : g.home_abbrev;
      const ours = rv.filter(r => r.game_id === g.game_id && r.team === abbr), theirs = rv.filter(r => r.game_id === g.game_id && r.opp === abbr);
      return `<tr><td>${fmtGameTime(g.game_date, g.start_utc)}</td><td>${g.home_abbrev === abbr ? "vs" : "@"} ${teamLink(opp)}</td><td class="sec" style="white-space:normal">${[
        ...ours.map(r => `↩ ${playerLink(r.player_id, r.name)} faces his old team (${r.gp_with} GP)`),
        ...theirs.map(r => `↩ ${opp}'s ${playerLink(r.player_id, r.name)} returns to face ${abbr} (${r.gp_with} GP here)`)].join("<br>")}</td></tr>`; }).join("")}</tbody></table>` : '<div class="muted">No games in the next two weeks.</div>'}</div>`;
  });
  formFor("teams", abbr, latest).then(({ f: fm, asOf }) => { const el = $("#form"); if (el) el.innerHTML = formCard(fm, asOf, latest, "team"); });
  const body = $("#body");
  const render = async () => {
    const fg = applyFilter(games, f, "result");
    $(".filter-note").textContent = `${fg.length} of ${games.length} games`;
    const a = aggTeam(fg);
    const pdo = a.shpct != null && a.svpct != null ? (a.shpct + a.svpct) * 1000 : null;
    const ctx = await teamRankContext(abbr, f.seasons?.length ? Math.max(...f.seasons) : latest, f.type === "P" ? "P" : "R");
    const T = items => tiles(items.map(([k, v, s, key]) => [k, v, s, key, rankFor(ctx, T_RANK, key, a)]));
    body.innerHTML = h`
      ${teamRankHeader(ctx, f)}
      ${T([["Record", recordStr(a), `${a.pts} pts · ${fmtSv(a.ptspct)}`, "rec"], ["GF/GP", fmt(a.gfpg, 2), "", "gf"], ["GA/GP", fmt(a.gapg, 2), "", "ga"], ["Goal diff", fmtSigned(a.diff), fmtSigned(div(a.diff, a.gp), 2) + "/GP", "diff"],
        ["SF/GP", fmt(a.sfpg, 1), "", "sf"], ["SA/GP", fmt(a.sapg, 1), "", "sa"], ["Shot share", fmtPct(a.sfpct), "", "sfpct"], ["PP%", fmtPct(a.pp), "", "pp"], ["PK%", fmtPct(a.pk), "", "pk"],
        ["Shooting %", fmtPct(a.shpct), "", "sh"], ["Save %", fmtSv(a.svpct), "", "sv"], ["PDO", fmt(pdo, 0), "~1000 = average luck"]])}
      <div class="card" style="margin-top:16px"><h2>Results <span class="muted">· oldest → newest</span></h2><div class="strip">${fg.map(g => `<a class="${g.result}" href="#/game/${g.game_id}" title="${shortDate(g.game_date)} ${g.is_home ? "vs" : "@"} ${g.opp_abbrev} ${g.gf}-${g.ga} ${g.decided_in !== "REG" ? "(" + g.decided_in + ")" : ""}">${g.result === "OTL" ? "O" : g.result}</a>`).join("")}</div>
        <div class="legend" style="margin-top:8px"><span>W = win</span><span>L = regulation loss</span><span>O = OT/shootout loss</span></div></div>
      <div class="card"><div class="chart-controls"><h2 style="margin:0">Trend</h2>
        <select id="metric">${[["goals", "Goals for vs against"], ["shots", "Shots for vs against"], ["diff", "Goal differential"], ["pts", "Points % (rolling)"]].map(([k, l]) => `<option value="${k}" ${k === metric ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select id="win">${[5, 10, 20].map(w => `<option value="${w}" ${w === win ? "selected" : ""}>${w}-game rolling</option>`).join("")}</select></div>
        <div class="legend" id="tleg"></div><div class="chart" id="trend"></div></div>
      <div class="card"><h2>Splits</h2><div id="splits"></div></div>
      <div class="grid2"><div class="card"><h2>Skaters <span class="muted" id="roster-note"></span></h2><div id="skaters"></div></div>
        <div class="card"><h2>Goalies</h2><div id="goalies"></div></div></div>
      <div class="card"><h2>Game log</h2><div id="log"></div></div>`;
    drawTrend(fg);
    splitsBlock($("#splits"), fg, "T", commonSplits("result", true));
    const ss = f.seasons || seasons, tp = f.type;
    $("#roster-note").textContent = `· ${ss.map(seasonLabel).join(", ")} · ${tp === "P" ? "Playoffs" : tp === "R" ? "Regular season" : "All games"} · season totals (other filters don't apply)`;
    const pick = rows => rows.filter(r => ss.includes(r.season) && (tp === "all" || r.game_type === tp));
    const rollUp = (rows, keys) => Object.values(groupBy(rows, r => r.id)).map(rs => { const o = { ...rs[0] }; for (const k of keys) o[k] = sum(rs, k); return o; });
    const sk = rollUp(pick(skaters), ["gp", "g", "a", "p", "sog", "ppp", "pm", "hits", "blk", "toi"]);
    sortTable($("#skaters"), sk, [{ k: "name", label: "Player", html: r => playerLink(r.id, r.name) }, { k: "pos", label: "Pos" }, { k: "gp", label: "GP", n: 1 },
      { k: "g", label: "G", n: 1 }, { k: "a", label: "A", n: 1 }, { k: "p", label: "P", n: 1 }, { k: "pgp", label: "P/GP", n: 1, html: r => fmt(r.p / r.gp, 2), sortVal: r => r.p / r.gp, csv: r => fmt(r.p / r.gp, 2) },
      { k: "sog", label: "SOG", n: 1 }, { k: "ppp", label: "PPP", n: 1 }, { k: "pm", label: "+/-", n: 1, fmt: v => fmtSigned(v) }, { k: "hits", label: "Hits", n: 1 },
      { k: "blk", label: "Blk", n: 1 }, { k: "toigp", label: "TOI/GP", n: 1, html: r => fmtToi(r.toi / r.gp), sortVal: r => r.toi / r.gp, csv: r => fmtToi(r.toi / r.gp) }], { sortKey: "p", csvName: `${abbr}-skaters` });
    const gk = rollUp(pick(goalies), ["gp", "gs", "w", "l", "otl", "sa", "sv", "ga", "toi"]);
    sortTable($("#goalies"), gk, [{ k: "name", label: "Goalie", html: r => playerLink(r.id, r.name) }, { k: "gp", label: "GP", n: 1 }, { k: "gs", label: "GS", n: 1 },
      { k: "rec", label: "Record", html: r => `${r.w}-${r.l}-${r.otl}`, sortVal: r => r.w }, { k: "svp", label: "SV%", n: 1, html: r => fmtSv(div(r.sv, r.sa)), sortVal: r => div(r.sv, r.sa) },
      { k: "gaa", label: "GAA", n: 1, html: r => fmt(r.toi ? r.ga * 3600 / r.toi : null, 2), sortVal: r => (r.toi ? r.ga * 3600 / r.toi : null) },
      { k: "share", label: "Start share", n: 1, html: r => fmtPct(r.gs / Math.max(1, sum(gk, "gs")), 0), sortVal: r => r.gs }], { sortKey: "gs", csvName: `${abbr}-goalies` });
    sortTable($("#log"), [...fg].reverse(), [
      { k: "game_date", label: "Date", html: r => `<a href="#/game/${r.game_id}">${shortDate(r.game_date)}</a>`, sortVal: r => r.game_date, csv: r => r.game_date },
      { k: "game_num", label: "#", n: 1 }, { k: "opp_abbrev", label: "Opp", html: oppCell, csv: r => (r.is_home ? "vs " : "@ ") + r.opp_abbrev },
      { k: "result", label: "Res", html: r => `${r.result}${r.decided_in && r.decided_in !== "REG" ? " (" + r.decided_in + ")" : ""}` },
      { k: "gf", label: "GF", n: 1 }, { k: "ga", label: "GA", n: 1 }, { k: "sog_for", label: "SF", n: 1 }, { k: "sog_against", label: "SA", n: 1 },
      { k: "pp", label: "PP", n: 1, html: r => `${r.pp_goals ?? "–"}/${r.pp_opps ?? "–"}`, sortVal: r => r.pp_goals }, { k: "pk", label: "PK GA", n: 1, html: r => `${r.pk_goals_against ?? "–"}/${r.pk_opps ?? "–"}`, sortVal: r => r.pk_goals_against },
      { k: "faceoff_pct", label: "FO%", n: 1, fmt: v => fmtPct(v, 0) }, { k: "hits", label: "Hits", n: 1 }, { k: "blocks", label: "Blk", n: 1 }, { k: "pim", label: "PIM", n: 1 },
      { k: "rest_days", label: "Rest", n: 1 }], { sortKey: "game_date", csvName: `${abbr}-gamelog` });
    $("#metric").onchange = e => { metric = e.target.value; render(); };
    $("#win").onchange = e => { win = +e.target.value; render(); };
  };
  function drawTrend(fg) {
    const xl = fg.map(g => shortDate(g.game_date));
    const tipBase = i => { const g = fg[i]; return `<b>${fmtDate(g.game_date)} ${g.is_home ? "vs" : "@"} ${g.opp_abbrev}</b><div class="row"><span>Result</span><span>${g.result} ${g.gf}-${g.ga}${g.decided_in !== "REG" ? " " + g.decided_in : ""}</span></div><div class="row"><span>Shots</span><span>${g.sog_for}-${g.sog_against}</span></div>`; };
    if (metric === "goals" || metric === "shots") {
      const [kf, ka, lab] = metric === "goals" ? ["gf", "ga", "Goals"] : ["sog_for", "sog_against", "Shots"];
      const rf = rolling(fg.map(g => g[kf]), win), ra = rolling(fg.map(g => g[ka]), win);
      $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>${lab} for (${win}-game avg)</span><span><i style="background:var(--series-2)"></i>${lab} against (${win}-game avg)</span>`;
      lineChart($("#trend"), { series: [{ name: "For", color: "var(--series-1)", values: rf }, { name: "Against", color: "var(--series-2)", values: ra }], xLabels: xl,
        yFmt: v => fmt(v, 1), tipHtml: i => tipBase(i) + `<div class="row"><span>${lab} for, ${win}g</span><span>${fmt(rf[i], 2)}</span></div><div class="row"><span>${lab} against, ${win}g</span><span>${fmt(ra[i], 2)}</span></div>` });
    } else if (metric === "diff") {
      const vals = fg.map(g => g.gf - g.ga), r = rolling(vals, win);
      $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>Goal differential (${win}-game avg)</span><span><i class="dash"></i>Even</span>`;
      lineChart($("#trend"), { series: [{ name: "Diff", color: "var(--series-1)", values: r, dots: vals }], ref: { value: 0 }, xLabels: xl, zeroBase: false,
        yFmt: v => fmtSigned(v, 1), tipHtml: i => tipBase(i) + `<div class="row"><span>Diff, ${win}g</span><span>${fmtSigned(r[i], 2)}</span></div>` });
    } else {
      const p = fg.map(g => (g.result === "W" ? 2 : g.result === "OTL" ? 1 : 0)), r = rollingRatio(p, fg.map(() => 2), win);
      $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>Points % (${win}-game)</span><span><i class="dash"></i>.500</span>`;
      lineChart($("#trend"), { series: [{ name: "P%", color: "var(--series-1)", values: r }], ref: { value: 0.5 }, xLabels: xl, yFmt: fmtSv,
        tipHtml: i => tipBase(i) + `<div class="row"><span>P%, ${win}g</span><span>${fmtSv(r[i])}</span></div>` });
    }
  }
  $("#fbar").appendChild(filterBar(f, { seasons, opps, onChange: render, resultLabel: "Result" }));
  render();
}

// ---------- screener
async function pageScreener(params) {
  const st = { season: +(params.get("season") || META.current_season), type: "R", tab: params.get("tab") || "skaters", pos: "all", team: "all", minGp: null, q: "" };
  app.innerHTML = `<div class="head"><div><h1>Screener</h1><div class="meta">Every player or team for a season, sortable on any column. "L10" columns compare the last 10 games to the season rate — the trend spotter.</div></div></div><div id="ctl" class="card filters"></div><div class="card" id="res"></div>`;
  const render = async () => {
    const league = await load(`league/${st.season}.json`);
    const ctl = $("#ctl");
    const opt = (arr, v) => arr.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? "selected" : ""}>${l}</option>`).join("");
    ctl.innerHTML = `<div class="chips">${["skaters", "goalies", "teams"].map(t => `<button class="chip ${st.tab === t ? "on" : ""}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
      <label>Season<select data-k="season">${opt([...META.seasons].reverse().map(s => [s, seasonLabel(s)]), st.season)}</select></label>
      <label>Game type<select data-k="type">${opt([["R", "Regular season"], ["P", "Playoffs"]], st.type)}</select></label>
      ${st.tab === "skaters" ? `<label>Position<select data-k="pos">${opt([["all", "All skaters"], ["F", "Forwards"], ["C", "C"], ["L", "LW"], ["R", "RW"], ["D", "Defense"]], st.pos)}</select></label>` : ""}
      ${st.tab !== "teams" ? `<label>Team<select data-k="team">${opt([["all", "All"], ...TEAMS.map(t => [t.abbrev, t.abbrev])], st.team)}</select></label>
      <label>Min GP<input type="number" min="0" data-k="minGp" value="${st.minGp ?? ""}" placeholder="auto" style="width:80px"></label>
      <label>Name<input type="search" data-k="q" value="${esc(st.q)}" placeholder="filter…"></label>` : ""}`;
    ctl.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { st.tab = b.dataset.tab; render(); });
    ctl.querySelectorAll("[data-k]").forEach(i => { i[i.type === "search" ? "oninput" : "onchange"] = () => { const k = i.dataset.k; st[k] = k === "season" ? +i.value : k === "minGp" ? (i.value === "" ? null : +i.value) : i.value; if (k === "q") drawTable(); else render(); }; });
    drawTable();
    function drawTable() {
      const res = $("#res");
      const F = league.form || {};
      const formCol = kind => ({ k: "form", label: "Form", html: r => formBadge(F[kind]?.[String(kind === "teams" ? r.team : r.player_id)]?.status),
        sortVal: r => F[kind]?.[String(kind === "teams" ? r.team : r.player_id)]?.score ?? null, csv: r => F[kind]?.[String(kind === "teams" ? r.team : r.player_id)]?.status || "" });
      if (st.tab === "teams") {
        const rows = objs(league.teams).filter(t => t.game_type === st.type).map(t => ({ ...t, ptspct: t.pts / (2 * t.gp), diff: t.gf - t.ga, gfpg: t.gf / t.gp, gapg: t.ga / t.gp,
          pp: div(t.ppg, t.ppo), pk: t.pko ? 1 - t.pkga / t.pko : null, sfpct: div(t.sf, t.sf + t.sa), l10pct: (2 * t.w10 + t.otl10) / (2 * Math.max(1, t.w10 + t.l10 + t.otl10)) }));
        sortTable(res, rows, [{ k: "team", label: "Team", html: r => `${teamLink(r.team)} <span class="muted">${esc(TEAM_BY[r.team]?.common_name || "")}</span>` }, formCol("teams"), { k: "gp", label: "GP", n: 1 },
          { k: "rec", label: "Record", html: r => `${r.w}-${r.l}-${r.otl}`, sortVal: r => r.pts }, { k: "pts", label: "PTS", n: 1 }, { k: "ptspct", label: "P%", n: 1, fmt: fmtSv },
          { k: "gfpg", label: "GF/GP", n: 1, fmt: v => fmt(v, 2) }, { k: "gapg", label: "GA/GP", n: 1, fmt: v => fmt(v, 2) }, { k: "diff", label: "Diff", n: 1, fmt: v => fmtSigned(v) },
          { k: "sfpct", label: "SF%", n: 1, fmt: v => fmtPct(v) }, { k: "pp", label: "PP%", n: 1, fmt: v => fmtPct(v) }, { k: "pk", label: "PK%", n: 1, fmt: v => fmtPct(v) },
          { k: "fo", label: "FO%", n: 1, fmt: v => fmtPct(v) }, { k: "l10", label: "L10", html: r => `${r.w10}-${r.l10}-${r.otl10}`, sortVal: r => r.l10pct },
          { k: "l10pct", label: "L10 P%", n: 1, fmt: fmtSv, cellCls: r => (r.l10pct - r.ptspct > 0.15 ? "hot" : r.l10pct - r.ptspct < -0.15 ? "cold" : "") },
          { k: "home", label: "Home W", html: r => `${r.hw}/${r.hgp}`, sortVal: r => r.hw / Math.max(1, r.hgp) }, { k: "away", label: "Away W", html: r => `${r.aw}/${r.agp}`, sortVal: r => r.aw / Math.max(1, r.agp) }],
          { sortKey: "pts", csvName: `teams-${st.season}` });
        return;
      }
      const isG = st.tab === "goalies";
      let rows = objs(isG ? league.goalies : league.skaters).filter(r => r.game_type === st.type);
      const maxGp = Math.max(0, ...rows.map(r => r.gp));
      const minGp = st.minGp ?? Math.max(1, Math.round(maxGp * (isG ? 0.25 : 0.3)));
      rows = rows.filter(r => r.gp >= minGp && (st.team === "all" || r.team === st.team) && (!st.q || r.name.toLowerCase().includes(st.q.toLowerCase())));
      if (!isG && st.pos !== "all") rows = rows.filter(r => (st.pos === "F" ? isF(r.pos) : r.pos === st.pos));
      const nameCol = { k: "name", label: "Player", html: r => playerLink(r.player_id, r.name) };
      if (isG) {
        rows = rows.map(r => ({ ...r, svpct: div(r.sv, r.sa), gaa: r.toi ? r.ga * 3600 / r.toi : null, sv10: div(r.sv10, r.sa10), sv5: div(r.sv5, r.sa5) })).map(r => ({ ...r, dsv: r.sv10 != null && r.svpct != null ? r.sv10 - r.svpct : null }));
        sortTable(res, rows, [nameCol, { k: "team", label: "Team", html: r => teamLink(r.team) }, formCol("goalies"), { k: "gp", label: "GP", n: 1 }, { k: "gs", label: "GS", n: 1 },
          { k: "rec", label: "Record", html: r => `${r.w}-${r.l}-${r.otl}`, sortVal: r => r.w }, { k: "sa", label: "SA", n: 1 }, { k: "ga", label: "GA", n: 1 },
          { k: "svpct", label: "SV%", n: 1, fmt: fmtSv }, { k: "gaa", label: "GAA", n: 1, fmt: v => fmt(v, 2) }, { k: "so", label: "SO", n: 1 },
          { k: "sv5", label: "L5 SV%", n: 1, fmt: fmtSv }, { k: "sv10", label: "L10 SV%", n: 1, fmt: fmtSv },
          { k: "dsv", label: "Δ L10", n: 1, fmt: v => (v == null ? "–" : fmtSigned(v * 1000, 0)), title: "Last-10 save % minus season, in points (.010 = 10)", cellCls: r => (r.dsv > 0.012 ? "hot" : r.dsv < -0.012 ? "cold" : "") },
          { k: "last_game", label: "Last GP", fmt: v => (v ? shortDate(v) : "–") }], { sortKey: "gp", csvName: `goalies-${st.season}` });
      } else {
        rows = rows.map(r => ({ ...r, pgp: r.p / r.gp, gpg: r.g / r.gp, sh: div(r.g, r.sog), sogpg: r.sog / r.gp, toigp: r.toi / r.gp,
          p10gp: r.gp10 ? r.p10 / r.gp10 : null, sog10gp: r.gp10 ? r.sog10 / r.gp10 : null, toi10gp: r.gp10 ? r.toi10 / r.gp10 : null })).map(r => ({ ...r, dp: r.p10gp != null ? r.p10gp - r.pgp : null, dtoi: r.toi10gp != null ? r.toi10gp - r.toigp : null }));
        sortTable(res, rows, [nameCol, { k: "team", label: "Team", html: r => teamLink(r.team) }, { k: "pos", label: "Pos" }, formCol("skaters"), { k: "gp", label: "GP", n: 1 },
          { k: "g", label: "G", n: 1 }, { k: "a", label: "A", n: 1 }, { k: "p", label: "P", n: 1 }, { k: "pgp", label: "P/GP", n: 1, fmt: v => fmt(v, 2) },
          { k: "sog", label: "SOG", n: 1 }, { k: "sh", label: "Sh%", n: 1, fmt: v => fmtPct(v) }, { k: "ppp", label: "PPP", n: 1 }, { k: "pm", label: "+/-", n: 1, fmt: v => fmtSigned(v) },
          { k: "hits", label: "Hits", n: 1 }, { k: "blk", label: "Blk", n: 1 }, { k: "toigp", label: "TOI/GP", n: 1, fmt: fmtToi },
          { k: "p5", label: "L5 P", n: 1 }, { k: "p10gp", label: "L10 P/GP", n: 1, fmt: v => fmt(v, 2) },
          { k: "dp", label: "Δ P/GP", n: 1, fmt: v => fmtSigned(v, 2), title: "Last-10 points per game minus season rate", cellCls: r => (r.dp > 0.3 ? "hot" : r.dp < -0.3 ? "cold" : "") },
          { k: "sog10gp", label: "L10 SOG/GP", n: 1, fmt: v => fmt(v, 1) },
          { k: "dtoi", label: "Δ TOI", n: 1, fmt: v => (v == null ? "–" : Math.abs(v) < 1 ? "0:00" : (v > 0 ? "+" : "-") + fmtToi(Math.abs(v))), title: "Last-10 TOI/GP minus season — role change signal", cellCls: r => (r.dtoi > 90 ? "hot" : r.dtoi < -90 ? "cold" : "") },
          { k: "last_game", label: "Last GP", fmt: v => (v ? shortDate(v) : "–") }], { sortKey: "p", limit: 400, csvName: `skaters-${st.season}` });
      }
    }
  };
  render();
}

// ---------- compare
async function pageCompare(params) {
  const isTeam = params.has("ta") || params.get("mode") === "teams";
  const A = params.get(isTeam ? "ta" : "a"), B = params.get(isTeam ? "tb" : "b");
  app.innerHTML = `<div class="head"><div><h1>Compare</h1><div class="meta">Side-by-side over the same filters, with an overlaid trend.</div></div>
    <div class="chips"><a class="chip ${!isTeam ? "on" : ""}" href="#/compare">Players</a><a class="chip ${isTeam ? "on" : ""}" href="#/compare?mode=teams">Teams</a></div></div>
    <div class="card filters"><div class="picker" style="flex:1"><label>${isTeam ? "Team" : "Player"} A</label><input id="pa" placeholder="Search…"><div class="search-results" hidden></div></div>
    <div class="picker" style="flex:1"><label>${isTeam ? "Team" : "Player"} B</label><input id="pb" placeholder="Search…"><div class="search-results" hidden></div></div></div><div id="cbody"></div>`;
  const go = (a, b) => { const q = new URLSearchParams(); if (isTeam) { if (a) q.set("ta", a); if (b) q.set("tb", b); if (!a && !b) q.set("mode", "teams"); } else { if (a) q.set("a", a); if (b) q.set("b", b); } location.hash = "#/compare?" + q; };
  attachPicker($("#pa"), isTeam, v => go(v, B));
  attachPicker($("#pb"), isTeam, v => go(A, v));
  if (isTeam) { if (A) $("#pa").value = teamName(A); if (B) $("#pb").value = teamName(B); }
  else { const find = id => INDEX.find(p => String(p.id) === String(id)); if (A) $("#pa").value = find(A)?.name || ""; if (B) $("#pb").value = find(B)?.name || ""; }
  if (!A || !B) { $("#cbody").innerHTML = `<div class="card empty">Pick two ${isTeam ? "teams" : "players"} to compare.</div>`; return; }

  const [da, db] = await Promise.all([load(isTeam ? `teams/${A}.json` : `players/${A}.json`), load(isTeam ? `teams/${B}.json` : `players/${B}.json`)]);
  const kind = isTeam ? "T" : (da.goalie && !da.skater && db.goalie && !db.skater) ? "G" : "S";
  const ga = objs(isTeam ? da.games : kind === "G" ? da.goalie : da.skater), gb = objs(isTeam ? db.games : kind === "G" ? db.goalie : db.skater);
  const nameA = isTeam ? teamName(A) : da.bio.name, nameB = isTeam ? teamName(B) : db.bio.name;
  const seasons = [...new Set([...ga, ...gb].map(g => g.season))].sort();
  const f = DEFAULT_FILTER(); f.seasons = [seasons[seasons.length - 1]]; f._defaultSeasons = f.seasons;
  const opps = [...new Set([...ga, ...gb].map(g => g.opp_abbrev))].sort();
  const resultKey = isTeam ? "result" : "team_result";
  const metrics = kind === "T" ? { gf: ["Goals for", g => g.gf], ga: ["Goals against", g => g.ga], sf: ["Shots for", g => g.sog_for], diff: ["Goal diff", g => g.gf - g.ga] }
    : kind === "G" ? { sv: ["Save %", null], ga: ["Goals against", g => g.goals_against], sa: ["Shots against", g => g.shots_against] }
    : SKATER_METRICS;
  let metric = Object.keys(metrics)[0], win = 10;
  const body = document.createElement("div");
  const render = () => {
    const fa = applyFilter(ga, f, resultKey), fb = applyFilter(gb, f, resultKey);
    $(".filter-note").textContent = `${fa.length} vs ${fb.length} games`;
    const agg = kind === "T" ? aggTeam : kind === "G" ? aggGoalie : aggSkater;
    const sa = agg(fa), sb = agg(fb);
    const cols = statCols(kind).filter(c => !c.html);
    const lowerBetter = new Set(["ga", "gapg", "sapg", "gaa", "pim"]);
    body.innerHTML = h`<div class="card"><table><thead><tr><th>Stat</th><th class="n">${esc(nameA)}</th><th class="n">${esc(nameB)}</th></tr></thead><tbody>
      ${cols.map(c => { const va = sa[c.k], vb = sb[c.k], f2 = c.fmt || (v => fmt(v)); const better = va == null || vb == null || va === vb ? 0 : (va > vb) !== lowerBetter.has(c.k) ? 1 : 2;
        return `<tr><td>${c.label}</td><td class="n">${better === 1 ? "<b>" + f2(va) + "</b>" : f2(va)}</td><td class="n">${better === 2 ? "<b>" + f2(vb) + "</b>" : f2(vb)}</td></tr>`; }).join("")}
      </tbody></table><div class="muted" style="font-size:12px;margin-top:6px">Bold = better of the two (raw totals favor whoever played more games; use the per-game rows).</div></div>
      <div class="card"><div class="chart-controls"><h2 style="margin:0">Trend</h2><select id="cm">${Object.entries(metrics).map(([k, [l]]) => `<option value="${k}" ${k === metric ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select id="cw">${[3, 5, 10, 20].map(w => `<option value="${w}" ${w === win ? "selected" : ""}>${w}-game rolling</option>`).join("")}</select><span class="muted">x-axis = game number within the filtered set</span></div>
      <div class="legend"><span><i style="background:var(--series-1)"></i>${esc(nameA)}</span><span><i style="background:var(--series-2)"></i>${esc(nameB)}</span></div><div class="chart" id="ctrend"></div></div>`;
    const series = (gs, color, name) => {
      let vals;
      if (metric === "sv") vals = rollingRatio(gs.map(g => g.saves), gs.map(g => g.shots_against), win);
      else vals = rolling(gs.map(metrics[metric][1]), win);
      return { name, color, values: vals, games: gs };
    };
    const s1 = series(fa, "var(--series-1)", nameA), s2 = series(fb, "var(--series-2)", nameB);
    const n = Math.max(fa.length, fb.length);
    const yf = metric === "sv" ? fmtSv : v => fmt(v, 2);
    lineChart($("#ctrend"), { series: [s1, s2], xLabels: Array.from({ length: n }, (_, i) => `G${i + 1}`), yFmt: yf, zeroBase: metric !== "sv" && metric !== "diff",
      tipHtml: i => `<b>Game ${i + 1} of filtered set</b>` + [s1, s2].map(s => `<div class="row"><span>${esc(s.name)}</span><span>${yf(s.values[i])}${s.games[i] ? " · " + shortDate(s.games[i].game_date) : ""}</span></div>`).join("") });
    $("#cm").onchange = e => { metric = e.target.value; render(); };
    $("#cw").onchange = e => { win = +e.target.value; render(); };
  };
  $("#cbody").appendChild(filterBar(f, { seasons, opps, onChange: render, resultLabel: isTeam ? "Result" : "Team result" }));
  $("#cbody").appendChild(body);
  render();
}


// ---------- goal leaders
async function pageGoals(params) {
  const seasons = [...META.seasons].sort();
  const cur = META.current_season, i = seasons.indexOf(cur);
  const last = seasons[i - 1], prev = seasons[i - 2];
  const st = { n: +(params.get("n") || 50), pos: "all" };
  const [L0, L1, L2] = await Promise.all([cur, last, prev].map(s => (s ? load(`league/${s}.json`).catch(() => null) : null)));
  const reg = L => objs(L?.skaters).filter(r => r.game_type === "R");
  const now = reg(L0), byId = L => Object.fromEntries(reg(L).map(r => [r.player_id, r]));
  const p1 = byId(L1), p2 = byId(L2);
  const teamGp = Object.fromEntries(objs(L0?.teams).filter(t => t.game_type === "R").map(t => [t.team, t.gp]));
  const form = L0?.form?.skaters || {};
  const render = () => {
    let pool = now.filter(r => st.pos === "all" || (st.pos === "F" ? isF(r.pos) : r.pos === st.pos));
    pool.sort((a, b) => b.g - a.g || a.gp - b.gp);
    const cutoff = pool[st.n - 1]?.g ?? 0;
    const rows = pool.filter((r, k) => k < st.n || r.g === cutoff && r.g > 0).map((r, k) => {
      const tg = teamGp[r.team] || r.gp, a = p1[r.player_id], b = p2[r.player_id];
      const pace = tg ? Math.round(r.g / tg * 82) : null, per82 = r.gp ? Math.round(r.g / r.gp * 82) : null;
      return { ...r, rank: pool.findIndex(x => x.g === r.g) + 1, tg, pace, per82, gpg: r.gp ? r.g / r.gp : null,
        g1: a?.g ?? null, gp1: a?.gp ?? null, g2: b?.g ?? null, gp2: b?.gp ?? null,
        vsLast: a ? pace - a.g : null, form: form[String(r.player_id)] };
    });
    app.innerHTML = h`
      <div class="head"><div><h1>Goal leaders</h1><div class="meta">Top ${st.n} goal scorers in ${seasonLabel(cur)} (ties at the cutoff included), with the two seasons before. Regular season only.</div></div></div>
      <div class="card filters">
        <label>Show<select id="gl-n">${[25, 50, 100].map(n => `<option value="${n}" ${n === st.n ? "selected" : ""}>Top ${n}</option>`).join("")}</select></label>
        <label>Position<select id="gl-pos">${[["all", "All skaters"], ["F", "Forwards"], ["C", "C"], ["L", "LW"], ["R", "RW"], ["D", "Defense"]].map(([k, l]) => `<option value="${k}" ${k === st.pos ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <span class="filter-note">On pace = goals ÷ team games played × 82 · Per 82 GP = goals ÷ his games played × 82</span>
      </div>
      <div class="card" id="gl"></div>`;
    sortTable($("#gl"), rows, [
      { k: "rank", label: "#", n: 1 },
      { k: "name", label: "Player", html: r => playerLink(r.player_id, r.name) },
      { k: "team", label: "Team", html: r => teamLink(r.team) }, { k: "pos", label: "Pos" },
      { k: "form", label: "Form", html: r => formBadge(r.form?.status), sortVal: r => r.form?.score ?? null, csv: r => r.form?.status || "" },
      { k: "g", label: `G ${seasonLabel(cur)}`, n: 1, html: r => `<b>${r.g}</b>`, csv: r => r.g },
      { k: "gp", label: "GP", n: 1, html: r => `${r.gp} <span class="muted">/ ${r.tg}</span>`, csv: r => r.gp, title: "His games played / his team's games played" },
      { k: "gpg", label: "G/GP", n: 1, fmt: v => fmt(v, 2) },
      { k: "pace", label: "On pace for", n: 1, html: r => `<b>${r.pace ?? "–"}</b>`, csv: r => r.pace },
      { k: "per82", label: "Per 82 GP", n: 1 },
      { k: "g1", label: last ? `G ${seasonLabel(last)}` : "Last year", n: 1, fmt: v => v ?? "–" },
      { k: "gp1", label: "GP", n: 1, fmt: v => v ?? "–" },
      { k: "g2", label: prev ? `G ${seasonLabel(prev)}` : "2 years ago", n: 1, fmt: v => v ?? "–" },
      { k: "gp2", label: "GP", n: 1, fmt: v => v ?? "–" },
      { k: "vsLast", label: "Pace vs last yr", n: 1, fmt: v => (v == null ? "–" : fmtSigned(v)), title: "This season's on-pace total minus last season's goals",
        cellCls: r => (r.vsLast == null ? "" : r.vsLast >= 8 ? "hot" : r.vsLast <= -8 ? "cold" : "") },
    ], { sortKey: "g", csvName: `goal-leaders-${cur}` });
    $("#gl-n").onchange = e => { st.n = +e.target.value; render(); };
    $("#gl-pos").onchange = e => { st.pos = e.target.value; render(); };
  };
  render();
}

// ---------- trends
async function pageTrends(params) {
  const st = { season: +(params.get("season") || META.current_season), grp: "all", team: "all", activeOnly: true, rvgp: REVENGE_DEFAULT };
  const render = async () => {
    const lg = await load(`league/${st.season}.json`);
    const form = lg.form || {};
    const asOf = form.as_of;
    const recent = d => !st.activeOnly || !asOf || (new Date(asOf) - new Date(d)) / 864e5 <= 10;
    const sk = objs(lg.skaters), gk = objs(lg.goalies);
    const info = {}; for (const r of [...sk, ...gk]) if (!info[r.player_id] || r.game_type === "R") info[r.player_id] = r;
    const people = (kind) => Object.entries(form[kind] || {}).map(([id, f]) => ({ id: +id, ...f, ...(info[id] ? { name: info[id].name, team: info[id].team, pos: info[id].pos || "G" } : { name: "#" + id }) }))
      .filter(r => recent(r.last_game) && (st.team === "all" || r.team === st.team) && (kind === "goalies" || st.grp === "all" || posGroup(r.pos) === st.grp));
    const S = people("skaters"), G = people("goalies");
    const T = Object.entries(form.teams || {}).map(([team, f]) => ({ team, ...f }));
    const li = r => `<li><span>${r.team && !r.id ? teamLink(r.team) + ` <span class="muted">${esc(TEAM_BY[r.team]?.common_name || "")}</span>` : playerLink(r.id, r.name) + ` <span class="muted">${esc(r.pos || "")} · ${esc(r.team || "")}</span>`}</span>
      <span>${formBadge(r.status)}</span><span class="why">${r.reasons.slice(0, 2).map(esc).join(" · ")}${r.flags?.length ? " " + flagChips(r.flags) : ""}</span></li>`;
    const list = (title, rows, empty) => `<div class="card"><h2>${title}</h2>${rows.length ? `<ul class="trend-list">${rows.map(li).join("")}</ul>` : `<div class="muted">${empty}</div>`}</div>`;
    const hot = arr => arr.filter(r => r.score >= 0.9).sort((a, b) => b.score - a.score);
    const cold = arr => arr.filter(r => r.score <= -0.9).sort((a, b) => a.score - b.score);
    const flagged = (arr, f) => arr.filter(r => r.flags?.includes(f)).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const opt = (arr, v) => arr.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? "selected" : ""}>${l}</option>`).join("");
    const counts = Object.fromEntries(Object.keys(FORM).map(k => [k, S.filter(r => r.status === k).length]));
    app.innerHTML = h`
      <div class="head"><div><h1>Trends</h1><div class="meta">Who's hot and who's cold${asOf ? ", as of " + fmtDate(asOf) : ""}. Recent games vs what we'd expect from that player or team, flagged only when the gap is too big to be ordinary noise.</div></div></div>
      <div class="card filters">
        <label>Season<select data-k="season">${opt([...META.seasons].reverse().map(x => [x, seasonLabel(x)]), st.season)}</select></label>
        <label>Skaters<select data-k="grp">${opt([["all", "All"], ["F", "Forwards"], ["D", "Defense"]], st.grp)}</select></label>
        <label>Team<select data-k="team">${opt([["all", "All"], ...TEAMS.map(t => [t.abbrev, t.abbrev])], st.team)}</select></label>
        <label>Players<select data-k="activeOnly">${opt([["true", "Played in last 10 days"], ["false", "Everyone"]], String(st.activeOnly))}</select></label>
        <span class="filter-note">${Object.entries(counts).map(([k, n]) => `${formBadge(k)} ${n}`).join(" &nbsp; ")}</span>
      </div>
      <div class="grid2">${list("Hottest skaters", hot(S).slice(0, 15), "Nobody is running well above expectation right now.")}${list("Coldest skaters", cold(S).slice(0, 15), "Nobody is running well below expectation right now.")}</div>
      <div class="grid2">${list("Hot goalies", hot(G).slice(0, 8), "No goalie is well above expectation.")}${list("Cold goalies", cold(G).slice(0, 8), "No goalie is well below expectation.")}</div>
      <div class="card"><div class="chart-controls"><h2 style="margin:0">Revenge games · next 7 days</h2>
        <select id="rvgp" aria-label="Minimum games with former team">${[50, 80, 150, 250].map(n => `<option value="${n}" ${n === st.rvgp ? "selected" : ""}>${n}+ games with old team</option>`).join("")}</select>
        <span class="muted">A player facing a team he played for (whole NHL career, via NHL.com profiles)</span></div><div id="rv"></div></div>
      <div class="card"><h2>Situational edges</h2><div id="sit"></div></div>
      <div class="card"><h2>Teams</h2><div id="tt"></div></div>
      <div class="grid3">${list("Likely to cool off", flagged([...S, ...T], "regression_risk").slice(0, 10), "None flagged.")}${list("Due to heat up", flagged([...S, ...T], "buy_low").slice(0, 10), "None flagged.")}${list("Role changes (ice time)", [...flagged(S, "role_up"), ...flagged(S, "role_down")].slice(0, 12), "None flagged.")}</div>
      <div class="card muted" style="font-size:12px"><b>How this works.</b> For each player we set an expected rate from his earlier games this season, blended with last season (or the league average for his position) so a short sample can't swing it. The last 10 and last 5 games are compared with that expectation using exact odds, and the result becomes a score. +0.9 or more is Warming and +1.8 or more is Hot; the same thresholds below zero mean Cooling and Cold. Goalies use save % over their last 5 and 10 games, and teams use points % plus goal differential over the last 10. "Likely to cool" marks hot runs built on unsustainable shooting % (or, for teams, PDO while being outshot). "Due to heat up" marks the reverse. Even in a league with no real streaks, about 1 in 20 players would show as Hot or Cold by chance, so use the reasons to judge each case.</div>`;
    sortTable($("#tt"), T, [{ k: "team", label: "Team", html: r => `${teamLink(r.team)} <span class="muted">${esc(TEAM_BY[r.team]?.common_name || "")}</span>` },
      { k: "status", label: "Form", html: r => formBadge(r.status), sortVal: r => r.score }, { k: "score", label: "Score", n: 1, fmt: v => fmtSigned(v, 1) },
      { k: "why", label: "Why", html: r => r.reasons.map(esc).join(" · ") + " " + flagChips(r.flags), csv: r => r.reasons.join(" | ") }], { sortKey: "score", csvName: `team-form-${st.season}` });
    app.querySelectorAll("[data-k]").forEach(i => i.onchange = () => { const k = i.dataset.k; st[k] = k === "season" ? +i.value : k === "activeOnly" ? i.value === "true" : i.value; render(); });
    drawSituational($("#sit"), st);
    const up = await loadUpcoming();
    const drawRv = () => {
      const limit = new Date(); limit.setDate(limit.getDate() + 7);
      const rows = (up?.revenge || []).filter(r => r.gp_with >= st.rvgp && new Date(r.date + "T12:00:00") <= limit
        && (st.team === "all" || r.team === st.team || r.opp === st.team) && (st.grp === "all" || posGroup(r.pos) === st.grp || r.pos === "G"));
      $("#rv").innerHTML = revengeList(rows);
    };
    drawRv();
    $("#rvgp").onchange = e => { st.rvgp = +e.target.value; drawRv(); };
  };
  await render();
}

// ---------- situational edges (Trends page)
const SIT_TABS = [
  ["road", "Road vs home", "Points per game in road games vs home games"],
  ["b2b", "Back-to-backs", "Points per game on the 2nd night of a back-to-back vs all other games"],
  ["trip", "Long road trips", "Points per game in the 3rd+ game of a road trip vs the first two road games"],
  ["dow", "Day of week", "Each player's most unusual day vs his other days (corrected for checking 7 days)"],
  ["streak", "Streaky scorers", "Chance of a point (or goal) the very next game after getting one vs after a game without"],
  ["matchup", "Matchups this week", "Points per game vs this week's opponent vs all other teams (all games since 2021-22)"],
  ["goalie", "Goalies", "Save % on the road and on the 2nd night of back-to-backs vs other starts"],
  ["teams", "Teams", "This season's points % by situation"],
];
const evidence = z => { const a = Math.abs(z); return a >= 2.5 ? ["Strong", 3] : a >= 1.8 ? ["Moderate", 2] : a >= 1.5 ? ["Weak", 1] : ["Noise", 0]; };
function signalNote(sig) {
  if (!sig) return "";
  const ratio = sig.expected ? sig.strong / sig.expected : 0;
  const verdict = ratio <= 1.3 ? "Mostly noise across the league — treat any single result here with caution."
    : ratio <= 2 ? "Some real signal mixed with noise — trust larger samples and strong evidence."
    : "Real signal — this situation genuinely matters for some players.";
  return `<div class="rank-bar"><span><b>Signal check:</b> ${sig.strong} strong patterns found among ${sig.n} players; chance alone would produce about ${sig.expected}. ${verdict}</span></div>`;
}
async function drawSituational(el, st) {
  let S;
  try { S = await load("situational.json"); } catch { el.innerHTML = '<div class="muted">Not available yet — appears after the next data refresh.</div>'; return; }
  let tab = st.sitTab || "road", show = st.sitShow || "signal";
  const render = () => {
    st.sitTab = tab; st.sitShow = show;
    const [, , desc] = SIT_TABS.find(t => t[0] === tab);
    const keep = r => (st.team === "all" || r.team === st.team || r.opp === st.team) && (st.grp === "all" || !r.pos || r.pos === "G" || posGroup(r.pos) === st.grp)
      && (show === "all" || Math.abs(r.z) >= 1.5);
    let rows = tab === "streak" ? S.streaks : tab === "matchup" ? S.matchups : tab === "goalie" ? S.goalies : tab === "teams" ? null : S.skaters.filter(r => r.cat === tab);
    el.innerHTML = `<div class="tabs">${SIT_TABS.map(([k, l]) => `<button class="tab ${k === tab ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
      <div class="chart-controls"><span class="sec">${desc}.${tab === "teams" ? "" : ` Seasons: ${S.seasons.map(seasonLabel).join(", ")}${tab === "matchup" ? " (matchups use every loaded season)" : ""}.`}</span>
      ${tab !== "teams" ? `<select id="sitshow"><option value="signal" ${show === "signal" ? "selected" : ""}>Show weak evidence or better</option><option value="all" ${show === "all" ? "selected" : ""}>Show everyone</option></select>` : ""}</div>
      ${tab !== "teams" ? signalNote(S.signal?.[tab]) : ""}<div id="sit-tbl"></div>`;
    el.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.k; render(); });
    const ss = el.querySelector("#sitshow"); if (ss) ss.onchange = e => { show = e.target.value; render(); };
    const tbl = el.querySelector("#sit-tbl");
    if (tab === "teams") {
      const T = S.teams.filter(t => st.team === "all" || t.team === st.team);
      const cell = k => ({ k, label: { all: "Overall", home: "Home", road: "Road", b2b2: "B2B 2nd night", trip3: "Road trip game 3+" }[k], n: 1,
        html: r => `${fmtSv(r[k].pct)} <span class="muted">(${r[k].n})</span>`, sortVal: r => r[k].pct, csv: r => r[k].pct,
        cellCls: r => (k === "all" || r[k].n < 3 || r[k].pct == null ? "" : r[k].pct - r.all.pct >= 0.1 ? "hot" : r[k].pct - r.all.pct <= -0.1 ? "cold" : "") });
      sortTable(tbl, T, [{ k: "team", label: "Team", html: r => `${teamLink(r.team)} <span class="muted">${esc(TEAM_BY[r.team]?.common_name || "")}</span>` },
        cell("all"), cell("home"), cell("road"), cell("b2b2"), cell("trip3")], { sortKey: "all", csvName: "team-situational" });
      tbl.insertAdjacentHTML("beforeend", `<div class="muted" style="font-size:12px;margin-top:6px">Points % (W = 2, OT loss = 1). Games in parentheses — team samples this early in the season are small.</div>`);
      return;
    }
    rows = rows.filter(keep);
    const isPct = r => r.unit === "pct";
    const f = (v, r) => (v == null ? "–" : r.stat === "svpct" ? fmtSv(v) : isPct(r) ? fmtPct(v, 0) : fmt(v, 2));
    const fd = (v, r) => (v == null ? "–" : r.stat === "svpct" ? fmtSigned(v * 1000, 0) + " pts" : isPct(r) ? fmtSigned(v * 100, 0) + " pp" : fmtSigned(v, 2));
    sortTable(tbl, rows, [
      { k: "name", label: "Player", html: r => playerLink(r.id, r.name) }, { k: "team", label: "Team", html: r => teamLink(r.team) }, { k: "pos", label: "Pos" },
      { k: "label", label: "Situation" },
      { k: "r1", label: "In situation", n: 1, html: r => `${f(r.r1, r)} <span class="muted">(${r.n1})</span>`, sortVal: r => r.r1, csv: r => r.r1 },
      { k: "r2", label: "Otherwise", n: 1, html: r => `${f(r.r2, r)} <span class="muted">(${r.n2})</span>`, sortVal: r => r.r2, csv: r => r.r2 },
      { k: "diff", label: "Difference", n: 1, html: r => fd(r.diff, r), csv: r => r.diff, cellCls: r => (Math.abs(r.z) < 1.5 ? "" : r.diff > 0 ? "hot" : "cold") },
      { k: "z", label: "Evidence", html: r => `${evidence(r.z)[0]} <span class="muted">${fmtSigned(r.z, 1)}</span>`, sortVal: r => r.z, csv: r => r.z,
        title: "How unlikely the gap is to be chance (z-score). Strong ≥ 2.5, Moderate ≥ 1.8, Weak ≥ 1.5" }],
      { sortKey: "z", limit: 300, csvName: `situational-${tab}` });
    tbl.insertAdjacentHTML("beforeend", `<div class="muted" style="font-size:12px;margin-top:6px">Rates are ${tab === "streak" ? "chance of a point/goal" : tab === "goalie" ? "save %" : "points per game"}; samples in parentheses (${tab === "goalie" ? "starts" : tab === "streak" ? "games" : "games"}). Green = better in the situation, red = worse. Sort "Evidence" either way to see both ends.</div>`);
  };
  render();
}

// ---------- scoring recap for a game day (home + games pages)
async function recapCard(el, date, games) {
  if (!el || !games.length) { if (el) el.innerHTML = ""; return; }
  el.innerHTML = `<div class="card"><h2>Scoring recap</h2><div class="muted">Loading box scores…</div></div>`;
  const boxes = await Promise.all(games.map(g => load(`box/${g.game_id}.json`).catch(() => null)));
  const rows = [];
  boxes.forEach(b => {
    if (!b) return;
    for (const r of objs(b.skaters)) {
      if (!r.p) continue;
      const home = r.team === b.game.home;
      rows.push({ ...r, opp: home ? b.game.away : b.game.home, is_home: home, game_id: b.game.id,
        won: (home ? b.game.home_score > b.game.away_score : b.game.away_score > b.game.home_score) });
    }
  });
  const nm = r => `${playerLink(r.id, r.name)} <span class="muted">${esc(r.team)}</span>`;
  const by = (k, min = 1) => rows.filter(r => r[k] >= min).sort((a, b) => b[k] - a[k] || b.p - a.p || a.name.localeCompare(b.name));
  const scorers = by("g"), assists = by("a"), multi = by("p", 2);
  const hat = rows.filter(r => r.g >= 3), big = rows.filter(r => r.p >= 4);
  const highlights = [
    ...hat.map(r => `🎩 ${nm(r)} hat trick${r.g > 3 ? ` (${r.g} goals)` : ""} ${r.is_home ? "vs" : "@"} ${r.opp}`),
    ...big.filter(r => r.g < 3).map(r => `⭐ ${nm(r)} ${r.p}-point night (${r.g}G ${r.a}A) ${r.is_home ? "vs" : "@"} ${r.opp}`),
  ];
  const list = (arr, fmtv) => arr.length ? `<ul class="recap-list">${arr.map(r => `<li><span>${nm(r)}</span><span class="num">${fmtv(r)}</span></li>`).join("")}</ul>` : '<div class="muted">None.</div>';
  el.innerHTML = `<div class="card"><h2>Scoring recap <span class="muted">· ${fmtDate(date)} · ${scorers.length} goal scorers, ${rows.length} players with a point</span></h2>
    ${highlights.length ? `<div class="recap-hl">${highlights.join("<br>")}</div>` : ""}
    <div class="grid3">
      <div><h3>Goals</h3>${list(scorers, r => `${r.g} G${r.ppp ? "" : ""}`)}</div>
      <div><h3>Assists</h3>${list(assists, r => `${r.a} A`)}</div>
      <div><h3>Points</h3>${list([...rows].sort((a, b) => b.p - a.p || b.g - a.g || a.name.localeCompare(b.name)), r => `${r.p} P <span class="muted">(${r.g}G ${r.a}A)</span>`)}</div>
    </div>
    <details style="margin-top:10px"><summary class="sec" style="cursor:pointer">Full table — everyone with a point (sortable, CSV)</summary><div id="recap-tbl" style="margin-top:8px"></div></details></div>`;
  sortTable(el.querySelector("#recap-tbl"), rows, [
    { k: "name", label: "Player", html: r => playerLink(r.id, r.name) }, { k: "team", label: "Team", html: r => teamLink(r.team) },
    { k: "opp", label: "Opp", html: r => `${r.is_home ? "vs" : "@"} ${teamLink(r.opp)}`, csv: r => (r.is_home ? "vs " : "@ ") + r.opp },
    { k: "g", label: "G", n: 1 }, { k: "a", label: "A", n: 1 }, { k: "p", label: "P", n: 1 }, { k: "ppp", label: "PPP", n: 1 },
    { k: "sog", label: "SOG", n: 1 }, { k: "pm", label: "+/-", n: 1, fmt: v => fmtSigned(v) }, { k: "toi", label: "TOI", n: 1, fmt: fmtToi },
    { k: "game", label: "Game", html: r => `<a href="#/game/${r.game_id}">Box score</a>`, csv: r => r.game_id }], { sortKey: "p", csvName: `scoring-${date}` });
}

// ---------- today's games (Games page)
const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
async function todaysGames(el) {
  if (!el) return;
  const up = await loadUpcoming();
  if (!up) return;
  const today = localISO(new Date());
  const all = objs(up.games);
  let games = all.filter(g => g.game_date === today), label = "Today's games";
  if (!games.length) {
    const next = all.find(g => g.game_date > today);
    el.innerHTML = `<div class="card"><h2>Today's games</h2><div class="muted">No NHL games today${next ? ` — next game day is ${fmtDate(next.game_date)}.` : "."}</div></div>`;
    return;
  }
  let lg = null;
  try { lg = await load(`league/${META.current_season}.json`); } catch { }
  const rec = Object.fromEntries(objs(lg?.teams).filter(t => t.game_type === "R").map(t => [t.team, t]));
  const form = lg?.form?.teams || {};
  const rv = (up.revenge || []).filter(r => r.date === today && r.gp_with >= REVENGE_DEFAULT);
  const side = (abbr, home) => {
    const t = rec[abbr], f = form[abbr];
    return `<div class="tg-team"><div class="tg-name">${home ? "" : ""}${teamLink(abbr)} <span class="muted">${esc(TEAM_BY[abbr]?.common_name || "")}</span></div>
      <div class="tg-meta">${t ? `${t.w}-${t.l}-${t.otl} · ${t.pts} pts · L10 ${t.w10}-${t.l10}-${t.otl10}` : "–"}</div>
      <div>${f ? formBadge(f.status) : ""}</div></div>`;
  };
  el.innerHTML = `<div class="card"><h2>${label} <span class="muted">· ${fmtDate(today)} · ${games.length} game${games.length > 1 ? "s" : ""}</span></h2>
    <div class="tg-list">${games.map(g => {
      const r = rv.filter(x => x.game_id === g.game_id);
      const time = g.start_utc ? new Date(g.start_utc).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
      return `<div class="tg-card"><div class="tg-time">${time}</div>${side(g.away_abbrev, false)}<div class="tg-at">@</div>${side(g.home_abbrev, true)}
        ${r.length ? `<div class="tg-rv">${r.map(x => `↩ ${playerLink(x.player_id, x.name)} (${esc(x.team)}) faces his old team — ${x.gp_with} GP with ${esc(x.opp)}`).join("<br>")}</div>` : ""}</div>`;
    }).join("")}</div>
    <div class="muted" style="font-size:12px;margin-top:8px">Scores appear in the morning refresh after games finish. Times in your time zone.</div></div>`;
}

// ---------- games list & box score
async function pageGames(params) {
  const st = { season: +(params.get("season") || META.current_season), date: params.get("date") || "" };
  const render = async () => {
    const gl = objs(await load(`games/${st.season}.json`));
    const dates = [...new Set(gl.map(g => g.game_date))].sort();
    if (!st.date || !dates.includes(st.date)) st.date = dates[dates.length - 1] || "";
    const i = dates.indexOf(st.date);
    app.innerHTML = `<div class="head"><div><h1>Games</h1><div class="meta">${gl.length} games in ${seasonLabel(st.season)}</div></div></div>
      <div id="today"></div>
      <div class="card filters"><label>Season<select id="gs">${[...META.seasons].reverse().map(s => `<option value="${s}" ${s === st.season ? "selected" : ""}>${seasonLabel(s)}</option>`).join("")}</select></label>
      <label>Date<input type="date" id="gd" value="${st.date}" min="${dates[0] || ""}" max="${dates[dates.length - 1] || ""}"></label>
      <button class="btn" id="prev" ${i <= 0 ? "disabled" : ""}>← Prev game day</button><button class="btn" id="next" ${i >= dates.length - 1 ? "disabled" : ""}>Next game day →</button></div>
      <div class="card"><h2>${st.date ? fmtDate(st.date) : ""}</h2><div class="games-list">${gl.filter(g => g.game_date === st.date).map(gameCard).join("") || '<div class="empty">No games on this date.</div>'}</div></div>
      <div id="recap"></div>
      <div class="card"><h2>All results</h2><div id="all"></div></div>`;
    todaysGames($("#today"));
    recapCard($("#recap"), st.date, gl.filter(g => g.game_date === st.date));
    $("#gs").onchange = e => { st.season = +e.target.value; st.date = ""; render(); };
    $("#gd").onchange = e => { st.date = e.target.value; const later = dates.find(d => d >= st.date); if (later) st.date = later; render(); };
    $("#prev").onclick = () => { st.date = dates[i - 1]; render(); };
    $("#next").onclick = () => { st.date = dates[i + 1]; render(); };
    sortTable($("#all"), gl, [{ k: "game_date", label: "Date", html: r => `<a href="#/game/${r.game_id}">${shortDate(r.game_date)}</a>`, sortVal: r => r.game_date, csv: r => r.game_date },
      { k: "game_type", label: "Type", fmt: v => (v === "P" ? "Playoffs" : "Reg") }, { k: "away_abbrev", label: "Away", html: r => teamLink(r.away_abbrev) }, { k: "away_score", label: "", n: 1 },
      { k: "home_abbrev", label: "Home", html: r => teamLink(r.home_abbrev) }, { k: "home_score", label: "", n: 1 }, { k: "last_period_type", label: "End", fmt: v => (v === "REG" ? "" : v) },
      { k: "total", label: "Total G", n: 1, html: r => r.away_score + r.home_score, sortVal: r => r.away_score + r.home_score, csv: r => r.away_score + r.home_score },
      { k: "away_sog", label: "Away SOG", n: 1 }, { k: "home_sog", label: "Home SOG", n: 1 }], { sortKey: "game_date", limit: 300, csvName: `games-${st.season}` });
  };
  render();
}

async function pageBox(id) {
  const d = await load(`box/${id}.json`);
  const g = d.game, sk = objs(d.skaters), gk = objs(d.goalies);
  const tm = Object.fromEntries(d.teams.map(t => [t.team_abbrev, t]));
  const side = ab => tm[ab] || {};
  const row = (label, k, f = v => v ?? "–") => `<tr><td class="n">${f(side(g.away)[k], side(g.away))}</td><td style="text-align:center" class="sec">${label}</td><td class="n">${f(side(g.home)[k], side(g.home))}</td></tr>`;
  app.innerHTML = h`
    <div class="head"><div><h1>${teamLink(g.away)} ${g.away_score} <span class="muted">@</span> ${teamLink(g.home)} ${g.home_score}</h1>
      <div class="meta">${fmtDate(g.date)} · ${g.type === "P" ? "Playoffs" : "Regular season"} · Final${g.ended_in && g.ended_in !== "REG" ? "/" + g.ended_in : ""}${g.venue ? " · " + esc(g.venue) : ""}</div></div></div>
    <div class="grid2"><div class="card"><h2>Team stats</h2><table><thead><tr><th class="n">${esc(g.away)}</th><th style="text-align:center"></th><th class="n">${esc(g.home)}</th></tr></thead><tbody>
      ${row("Shots on goal", "sog_for")}${row("Power play", "pp_goals", (v, t) => `${v ?? "–"}/${t.pp_opps ?? "–"}`)}${row("Faceoff %", "faceoff_pct", v => fmtPct(v, 0))}
      ${row("Hits", "hits")}${row("Blocked shots", "blocks")}${row("PIM", "pim")}${row("Giveaways", "giveaways")}${row("Takeaways", "takeaways")}${row("Rest days", "rest_days")}</tbody></table></div>
      <div class="card"><h2>Goalies</h2><div id="bg"></div></div></div>
    <div class="card"><h2>${esc(teamName(g.away))}</h2><div id="ba"></div></div>
    <div class="card"><h2>${esc(teamName(g.home))}</h2><div id="bh"></div></div>`;
  const skCols = [{ k: "name", label: "Player", html: r => playerLink(r.id, r.name) }, { k: "pos", label: "Pos" }, { k: "g", label: "G", n: 1 }, { k: "a", label: "A", n: 1 }, { k: "p", label: "P", n: 1 },
    { k: "pm", label: "+/-", n: 1, fmt: v => fmtSigned(v) }, { k: "sog", label: "SOG", n: 1 }, { k: "ppp", label: "PPP", n: 1 }, { k: "hits", label: "Hits", n: 1 }, { k: "blk", label: "Blk", n: 1 },
    { k: "pim", label: "PIM", n: 1 }, { k: "toi", label: "TOI", n: 1, fmt: fmtToi }, { k: "fo", label: "FO%", n: 1, fmt: (v, r) => (r.pos === "C" && v != null ? fmtPct(v, 0) : "–") }];
  sortTable($("#ba"), sk.filter(s => s.team === g.away), skCols, { sortKey: "toi", full: true });
  sortTable($("#bh"), sk.filter(s => s.team === g.home), skCols, { sortKey: "toi", full: true });
  sortTable($("#bg"), gk, [{ k: "name", label: "Goalie", html: r => playerLink(r.id, r.name) }, { k: "team", label: "Team" }, { k: "dec", label: "Dec" }, { k: "sa", label: "SA", n: 1 },
    { k: "sv", label: "SV", n: 1 }, { k: "ga", label: "GA", n: 1 }, { k: "svp", label: "SV%", n: 1, html: r => fmtSv(div(r.sv, r.sa)) }, { k: "toi", label: "TOI", n: 1, fmt: fmtToi }], { sortKey: "toi" });
}

// ------------------------------------------------------------------ search
function matches(q, limit = 12) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const teams = TEAMS.filter(t => t.abbrev.toLowerCase() === q || (t.name || "").toLowerCase().includes(q)).map(t => ({ href: `#/team/${t.abbrev}`, label: t.name || t.abbrev, sub: "Team", val: t.abbrev }));
  const ps = INDEX.filter(p => p.name && p.name.toLowerCase().includes(q))
    .sort((a, b) => (b.last_game > a.last_game ? 1 : -1) || b.gp - a.gp)
    .slice(0, limit).map(p => ({ href: `#/player/${p.id}`, label: p.name, sub: `${p.pos || ""} · ${p.team || ""}`, val: p.id }));
  return [...teams.slice(0, 4), ...ps].slice(0, limit);
}
function wireSearch(input, box, { teamsOnly = false, onPick } = {}) {
  let hl = -1, items = [];
  const draw = () => {
    items = matches(input.value).filter(m => !teamsOnly || m.sub === "Team");
    if (!onPick && teamsOnly === false) { /* global search: all */ }
    if (onPick && !teamsOnly) items = items.filter(m => m.sub !== "Team");
    box.hidden = !items.length;
    box.innerHTML = items.map((m, i) => `<a href="${m.href}" data-i="${i}" class="${i === hl ? "hl" : ""}"><span>${esc(m.label)}</span><span class="muted">${esc(m.sub)}</span></a>`).join("");
    box.querySelectorAll("a").forEach(a => a.onmousedown = e => { if (onPick) { e.preventDefault(); pick(+a.dataset.i); } });
  };
  const pick = i => { const m = items[i]; if (!m) return; box.hidden = true; if (onPick) { input.value = m.label; onPick(m.val); } else { location.hash = m.href; input.value = ""; } };
  input.addEventListener("input", () => { hl = -1; draw(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { hl = Math.min(items.length - 1, hl + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { hl = Math.max(0, hl - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") { pick(hl < 0 ? 0 : hl); }
    else if (e.key === "Escape") box.hidden = true;
  });
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
}
function attachPicker(input, teams, onPick) { wireSearch(input, input.nextElementSibling, { teamsOnly: teams, onPick }); }

// ------------------------------------------------------------------ router
async function route() {
  hideTip();
  const [path, query] = location.hash.slice(1).split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === (parts[0] || "home")));
  app.innerHTML = '<div class="loading">Loading…</div>';
  scrollTo(0, 0);
  try {
    if (!parts.length) await pageHome();
    else if (parts[0] === "player") await pagePlayer(parts[1]);
    else if (parts[0] === "team") await pageTeam(parts[1]);
    else if (parts[0] === "screener") await pageScreener(params);
    else if (parts[0] === "compare") await pageCompare(params);
    else if (parts[0] === "games") await pageGames(params);
    else if (parts[0] === "trends") await pageTrends(params);
    else if (parts[0] === "goals") await pageGoals(params);
    else if (parts[0] === "game") await pageBox(parts[1]);
    else app.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card empty">Couldn't load this page (${esc(e.message)}).</div>`;
  }
}

async function init() {
  const saved = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme").onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch { }
    document.querySelectorAll(".chart").forEach(c => c._redraw && c._redraw());
  };
  try {
    [META, TEAMS] = await Promise.all([load("meta.json"), load("teams.json")]);
    INDEX = objs(await load("players.json"));
  } catch (e) {
    app.innerHTML = `<div class="card empty">No data yet. Run the backfill workflow first (${esc(e.message)}).</div>`;
    return;
  }
  TEAM_BY = Object.fromEntries(TEAMS.map(t => [t.abbrev, t]));
  TEAMS.sort((a, b) => a.abbrev.localeCompare(b.abbrev));
  $("#updated").textContent = `Data through ${META.last_game ? fmtDate(META.last_game) : "–"} · refreshed ${new Date(META.updated_at).toLocaleString()}`;
  wireSearch($("#search"), $("#search-results"));
  addEventListener("hashchange", route);
  route();
}
init();
