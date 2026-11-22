// Forever Watcher front end: a static single-page app over the JSON in ./data/.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`fw:${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`fw:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Data files are versioned by the meta's generation time, so the CDN and browser can't serve an
// older copy, and an open tab picks up each new hourly snapshot (see watchForUpdates).
const cache = new Map();
let dataVersion = "";
async function load(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(`data/${path}?v=${dataVersion}`, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { cache.delete(path); throw e; }));
  }
  return cache.get(path);
}

// ---------- formatting ----------
function money(c, { plain = false } = {}) {
  if (c == null || Number.isNaN(c)) return '<span class="muted">–</span>';
  const neg = c < 0;
  c = Math.abs(Math.round(c));
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100;
  if (plain) return `${neg ? "-" : ""}${g ? `${g.toLocaleString()}g ` : ""}${g || s ? `${s}s ` : ""}${cc}c`;
  const parts = [];
  if (g) parts.push(`<i class="g" title="gold">${g.toLocaleString()}</i>`);
  if (g || s) parts.push(`<i class="s" title="silver">${s}</i>`);
  if (!g || cc) parts.push(`<i class="c" title="copper">${cc}</i>`);
  return `<span class="money" aria-label="${money(neg ? -c : c, { plain: true })}">${neg ? "-" : ""}${parts.join("")}</span>`;
}
const pct = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const signed = (x) => (x == null ? '<span class="muted">–</span>' : `<span class="${x >= 0 ? "pos" : "neg"}">${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%</span>`);
const fixed = (x, d = 1) => (x == null ? "–" : Number(x).toFixed(d));
const ago = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - (typeof iso === "number" ? iso : Date.parse(iso))) / 60000);
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const baseOf = (key) => String(key).split("-")[0];
const bonusOf = (key) => String(key).split("-")[1] ?? null;
const itemHref = (region, key) => `#/item/${region}/${baseOf(key)}${bonusOf(key) ? `/${encodeURIComponent(key)}` : ""}`;
const iconUrl = (icon) => (String(icon ?? "").startsWith("http") ? icon : `https://render.worldofwarcraft.com/us/icons/56/${icon || "inv_misc_questionmark"}.jpg`);
const itemCell = (name, q, icon, sub = "") =>
  `<span class="item"><span class="icon" style="background-image:url('${iconUrl(icon)}')"></span><span><span class="q-${esc(q)}">${esc(name)}</span>${sub ? `<div class="sub">${sub}</div>` : ""}</span></span>`;
const goldToCopper = (g) => Math.round(Number(g || 0) * 10000);

function sparkline(vals, { w = 104, h = 26 } = {}) {
  const v = (vals ?? []).filter((x) => x != null);
  if (v.length < 2) return '<span class="muted spark-empty">gathering</span>';
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((x - lo) / span) * (h - 6)).toFixed(1)}`);
  const up = v.at(-1) >= v[0];
  const col = up ? "#8fd49a" : "#e0704a";
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${up ? "rising" : "falling"} trend"><polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${pts.at(-1).split(",")[0]}" cy="${pts.at(-1).split(",")[1]}" r="2.4" fill="${col}"/></svg>`;
}
const FACTION_COLOR = { alliance: "#6f9cf2", horde: "#e2675a", neutral: "#e3b85c", unknown: "#b9aa8c" };
const factionName = (h) => (h.faction === "neutral" ? "Blackwater" : h.faction[0].toUpperCase() + h.faction.slice(1));

// ---------- app state ----------
const S = {
  meta: null,
  region: store.get("region", "us"),
  group: store.get("group", "all"),
  watch: store.get("watch", []),
};
const houses = () => S.meta?.regions?.[S.region]?.houses ?? [];
const house = (id) => houses().find((h) => h.id === Number(id));
const houseLabel = (id) => {
  const h = house(id);
  return h ? `<span class="fac ${h.faction}">${esc(h.faction === "neutral" ? "Blackwater" : h.faction[0].toUpperCase() + h.faction.slice(1))}</span> <span class="sub">${esc(h.groupName)} · #${h.id}</span>` : `#${id}`;
};
/** How old a house's data is: Blizzard's data time when known, else our last scan. */
const freshness = (h) => {
  const t = h?.dataTime ?? h?.lastScan;
  if (!t) return '<span class="muted">no data yet</span>';
  const mins = (Date.now() - t) / 60000;
  return `<span class="${mins > 150 ? "neg" : mins > 90 ? "warn" : ""}" title="Blizzard's snapshot time${h.checked ? `; last checked ${ago(h.checked)}` : ""}">${ago(t)}</span>`;
};
const inGroup = (id) => S.group === "all" || house(id)?.group === Number(S.group);

async function index() {
  const rows = await load(`index-${S.region}.json`);
  if (!index.maps) index.maps = {};
  if (!index.maps[S.region]) index.maps[S.region] = new Map(rows.map((r) => [r[0], { key: r[0], name: r[1], q: r[2], icon: r[3], cls: r[4], sell: r[5], variants: r[6] ?? 1 }]));
  return index.maps[S.region];
}

// ---------- sortable table ----------
function table(cols, rows, { sortKey, desc = true, onRow, empty = "Nothing here yet.", limit = 250, compact = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "tablewrap" + (compact ? " compact" : "");
  const pos = new Map(rows.map((r, i) => [r, i]));
  let shown = limit;
  let key = sortKey ?? cols.find((c) => c.sort)?.key;
  let dir = desc ? -1 : 1;
  const render = () => {
    const col = cols.find((c) => c.key === key);
    const sorted = col?.sort ? [...rows].sort((a, b) => {
      const x = col.sort(a), y = col.sort(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    }) : rows;
    wrap.innerHTML = `<table><thead><tr>${cols.map((c) => `<th data-k="${c.key}" class="${c.num ? "num" : ""} ${c.key === key ? `sorted ${dir > 0 ? "asc" : ""}` : ""}" title="${esc(c.title ?? "")}">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${sorted.length ? sorted.slice(0, shown).map((r, i) => `<tr data-i="${pos.get(r)}">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.html(r, i)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length}" class="empty">${empty}</td></tr>`}
      ${sorted.length > shown ? `<tr class="more-row"><td colspan="${cols.length}"><button class="ghost more">Show ${Math.min(limit, sorted.length - shown).toLocaleString()} more · ${sorted.length.toLocaleString()} in all</button></td></tr>` : ""}</tbody></table>`;
  };
  wrap.addEventListener("click", (e) => {
    if (e.target.closest(".more")) { shown += limit; render(); return; }
    const th = e.target.closest("th");
    if (th) {
      const c = cols.find((x) => x.key === th.dataset.k);
      if (!c?.sort) return;
      if (key === c.key) dir = -dir;
      else { key = c.key; dir = -1; }
      shown = limit;
      render();
      return;
    }
    const tr = e.target.closest("tbody tr[data-i]");
    if (tr && onRow && !e.target.closest("a,button,input")) onRow(rows[Number(tr.dataset.i)]);
  });
  render();
  return wrap;
}

// ---------- views ----------
const TYPE_INFO = {
  flip: "Underpriced listings bought and relisted in the same house.",
  arbitrage: "Bought in one house, relisted in another house of the same ruleset group.",
  vendor: "Listed below the vendor sell price: buy and sell to any merchant.",
  craft: "Buy the reagents, craft, and sell the product. Needs the recipe.",
  disenchant: "Buy gear priced under the value of what it disenchants into (Classic odds, unverified). Needs Enchanting.",
};

function warmup() {
  const r = S.meta.regions[S.region];
  const hrs = r.historyHours ?? 0, tracked = r.trackedHours ?? 0;
  const need = 12;
  const p = Math.min(1, hrs / need);
  return `<div class="warmup"><b>Still gathering history.</b> Flips and arbitrage need a price baseline (about ${need} hourly scans) and a few hours of sales tracking.
    <div class="bar"><span style="width:${(p * 100).toFixed(0)}%"></span></div>
    <span class="note">${hrs} of ${need} hours of price history · ${fixed(tracked)} hours of sales tracked. Meanwhile, browse live prices in <a href="#/market">Market</a>.</span></div>`;
}

async function viewOpps(el) {
  const [opps, idx] = await Promise.all([load(`opps-${S.region}.json`), index()]);
  void idx;
  const f = store.get("oppFilters", { type: "all", minProfit: 1, minRoi: 15, grade: "D", maxCost: "", q: "" });
  const bt = S.meta.backtest?.byType ?? {};
  const btCard = (t) => {
    const b = bt[t];
    return `<div class="card"><div class="k">${t} backtest hit rate</div><div class="v">${b?.evaluated ? pct(b.hitRate) : "–"}</div><div class="note">${b?.evaluated ? `${b.evaluated} trades checked, ${pct(b.realisedRoi)} realised ROI` : "builds up after 3 days of data"}</div></div>`;
  };
  const visible = opps.filter((o) => inGroup(o.buy) && (o.sell == null || inGroup(o.sell)));
  el.innerHTML = `
    <h1 class="gilded">Opportunities</h1>
    <p class="lead">Trades ranked by expected profit after the AH cut and deposits, with quantity capped at what the market has been absorbing (estimated sales per day × ${S.meta.settings.horizonDays} days). The grade reflects how much history and sales data backs the estimate.</p>
    <div class="cards">
      <div class="card"><div class="k">Open opportunities</div><div class="v">${visible.length}</div><div class="note">${S.region.toUpperCase()} · ${esc(scopeName())}</div></div>
      <div class="card"><div class="k">Top expected profit</div><div class="v">${money(visible[0]?.ev)}</div><div class="note">${esc(visible[0]?.name ?? "")}</div></div>
      ${btCard("flip")}${btCard("arbitrage")}
    </div>
    <div class="filters">
      <label>Type<select id="f-type"><option value="all">All</option><option value="flip">Flip</option><option value="arbitrage">Arbitrage</option><option value="vendor">Vendor</option><option value="craft">Craft</option><option value="disenchant">Disenchant</option></select></label>
      <label>Min profit (g)<input id="f-minProfit" type="number" min="0" step="1"></label>
      <label>Min ROI (%)<input id="f-minRoi" type="number" min="0" step="5"></label>
      <label>Min grade<select id="f-grade"><option>A</option><option>B</option><option>C</option><option>D</option></select></label>
      <label>Max capital (g)<input id="f-maxCost" type="number" min="0" step="10" placeholder="any"></label>
      <label>Item<input id="f-q" type="search" placeholder="filter by name"></label>
    </div>
    ${(S.meta.regions[S.region].historyHours ?? 0) < 12 ? `<div class="frame warm-frame">${warmup()}</div>` : ""}
    <div id="opps-table"></div>
    <p class="note">Fees: ${pct(S.meta.fees.cutRate, 1)} AH cut, deposit ${pct(S.meta.fees.depositVendorRate)} of vendor price (min ${money(S.meta.fees.depositMinCopper)}).${S.meta.fees.verified ? "" : " <b>Not yet verified for WoW: Forever</b>: see Status."} Relist prices undercut the cheapest competing listing left after your purchase.</p>`;
  for (const [k, v] of Object.entries(f)) { const i = $(`#f-${k}`, el); if (i) i.value = v; }
  const grades = ["D", "C", "B", "A"];
  const draw = () => {
    for (const k of Object.keys(f)) f[k] = $(`#f-${k}`, el).value;
    store.set("oppFilters", f);
    const q = f.q.trim().toLowerCase();
    const rows = visible.filter((o) =>
      (f.type === "all" || o.type === f.type) &&
      o.ev >= goldToCopper(f.minProfit) &&
      (o.type === "vendor" || o.roi * 100 >= Number(f.minRoi || 0)) &&
      grades.indexOf(o.grade) >= grades.indexOf(f.grade) &&
      (!f.maxCost || o.cost <= goldToCopper(f.maxCost)) &&
      (!q || o.name.toLowerCase().includes(q)));
    const t = table([
      { key: "name", label: "Item", html: (o) => itemCell(o.name, o.q, o.icon, [bonusOf(o.key) ? `variant ${bonusOf(o.key)}` : "", o.note ? esc(o.note) : ""].filter(Boolean).join(" · ")), sort: (o) => o.name },
      { key: "type", label: "Type", html: (o) => `<span class="pill t-${o.type}" title="${esc(TYPE_INFO[o.type])}">${o.type}</span>`, sort: (o) => o.type },
      { key: "buy", label: "Buy in", html: (o) => houseLabel(o.buy) },
      { key: "sell", label: "Sell in", html: (o) => (o.type === "vendor" ? '<span class="sub">any vendor</span>' : o.type === "disenchant" ? '<span class="sub">materials, same house</span>' : houseLabel(o.sell)) },
      { key: "units", label: "Units", num: true, html: (o) => o.units.toLocaleString(), sort: (o) => o.units },
      { key: "buyMax", label: "Buy ≤", num: true, title: "Highest unit price you pay", html: (o) => (o.type === "craft" ? `<span class="sub">${o.crafts} crafts</span>` : money(o.buyMax)), sort: (o) => o.buyMax },
      { key: "sellAt", label: "Relist at", num: true, title: "Per unit (disenchant: material value per item)", html: (o) => money(o.sellAt), sort: (o) => o.sellAt },
      { key: "cost", label: "Capital", num: true, html: (o) => money(o.cost), sort: (o) => o.cost },
      { key: "ev", label: "Exp. profit", num: true, html: (o) => `<b>${money(o.ev)}</b>`, sort: (o) => o.ev },
      { key: "roi", label: "ROI", num: true, html: (o) => pct(o.roi), sort: (o) => o.roi },
      { key: "days", label: "Days", num: true, title: "Estimated days to sell the units", html: (o) => (o.type === "vendor" ? "0" : fixed(o.days)), sort: (o) => o.days },
      { key: "grade", label: "Grade", html: (o) => `<span class="grade ${o.grade}" title="A: lots of history, steady price and sales · D: thin data">${o.grade}</span>`, sort: (o) => grades.indexOf(o.grade) },
    ], rows, { sortKey: "ev", onRow: (o) => (location.hash = itemHref(S.region, o.key)), empty: opps.length ? "No opportunities match these filters." : (S.meta.regions[S.region].historyHours ?? 0) < 12 ? "Nothing flagged yet." : "No trades clear the profit and ROI bars right now." });
    $("#opps-table", el).replaceChildren(t);
  };
  el.addEventListener("input", (e) => { if (e.target.closest(".filters")) draw(); });
  draw();
}

let chart = null;
let depth = null;
async function viewItem(el, region, base, variantKey) {
  if (region !== S.region) setRegion(region);
  const idx = await index();
  const info = idx.get(base) ?? { name: `Item ${base}`, q: "COMMON" };
  let file;
  try { file = await load(`items/${region}/${base}.json`); } catch { el.innerHTML = `<p class="empty">No market data for item ${esc(base)} in ${region.toUpperCase()} yet.</p>`; return; }
  const listedCount = (k) => Object.values(file.variants[k]).filter((v) => v.m?.listed).reduce((n, v) => n + (v.h.at(-1)?.[3] ?? 0), 0);
  const vkeys = Object.keys(file.variants).sort((a, b) => (a === base ? -1 : b === base ? 1 : listedCount(b) - listedCount(a)));
  const vkey = variantKey && file.variants[variantKey] ? variantKey : vkeys.slice().sort((a, b) => listedCount(b) - listedCount(a))[0];
  const data = { houses: file.variants[vkey] };
  const hs = Object.entries(data.houses).map(([hid, v]) => ({ hid: Number(hid), ...v, last: v.h.at(-1) })).filter((x) => house(x.hid));
  const rows = hs.sort((a, b) => (b.m?.soldPerDay ?? 0) - (a.m?.soldPerDay ?? 0) || (b.last?.[3] ?? 0) - (a.last?.[3] ?? 0));
  const listedRows = rows.filter((x) => x.m?.listed);
  const main = listedRows.slice().sort((a, b) => b.last[3] - a.last[3])[0] ?? rows[0];
  const cheapest = listedRows.slice().sort((a, b) => a.last[2] - b.last[2])[0];
  const ch7 = (() => {
    const d = main?.d ?? [];
    const cur = d.at(-1);
    if (!cur?.[1]) return null;
    const today = Math.floor(Date.now() / 86400000);
    for (let i = d.length - 1; i >= 0; i--) if (d[i][0] <= today - 7 && d[i][1]) return cur[1] / d[i][1] - 1;
    return null;
  })();
  const spd = rows.reduce((s, x) => s + (x.m?.soldPerDay ?? 0), 0);
  const lastSeen = rows.map((x) => x.last).filter(Boolean).sort((a, b) => b[0] - a[0])[0];
  const anySpd = rows.some((x) => x.m?.soldPerDay != null);
  const watched = S.watch.find((w) => w.region === region && w.key === vkey);
  const stat = (k, v, n = "") => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div>${n ? `<div class="note">${n}</div>` : ""}</div>`;
  el.innerHTML = `
    <div class="itemhead"><span class="icon lg" style="background-image:url('${iconUrl(info.icon)}')"></span>
      <div><h1 class="q-${esc(info.q)}">${esc(info.name)}</h1><div class="meta">${esc(info.cls ?? "Item")} · #${esc(base)}${info.sell != null ? ` · vendors for ${money(info.sell)}` : ""} · ${region.toUpperCase()}</div></div>
      <div class="watchbox">
        <label>Alert under (gold)<input id="w-target" type="number" min="0" step="0.01" style="width:120px" value="${watched?.target != null ? watched.target / 10000 : ""}"></label>
        <button class="${watched ? "ghost" : "primary"}" id="w-btn">${watched ? "Stop watching" : "Watch"}</button>
      </div>
    </div>
    ${vkeys.length > 1 ? `<div class="variant-bar"><label class="note" for="v-sel">Variant (random suffixes are priced separately)</label><select id="v-sel">${vkeys.map((k) => `<option value="${esc(k)}" ${k === vkey ? "selected" : ""}>${k === base ? "Plain" : `Bonus ${esc(bonusOf(k))}`} · ${listedCount(k).toLocaleString()} listed</option>`).join("")}</select></div>` : ""}
    <div class="cards stats">
      ${stat("Lowest now", cheapest ? money(cheapest.last[2]) : "not listed", cheapest ? factionName(house(cheapest.hid)) : "")}
      ${stat("Market value", main?.m?.listed ? money(main.last[1]) : lastSeen ? money(lastSeen[1]) : "–", main?.m?.listed ? `${factionName(house(main.hid))}, busiest house` : lastSeen ? `last seen ${ago(lastSeen[0] * 3600000)} · sold out now` : "")}
      ${stat("Baseline", money(main?.m?.baseline), `${S.meta.settings.baselineDays}-day average`)}
      ${stat("Change", `${signed(main?.m?.chg24)} <span class="note">24h</span>`, `${ch7 == null ? "–" : signed(ch7)} over 7 days`)}
      ${stat("Sold a day", anySpd ? fixed(spd) : "–", anySpd && (main?.last ?? lastSeen) ? `≈ ${money(spd * (main?.m?.listed ? main.last[1] : lastSeen[1]), { plain: true })} traded daily` : "needs a few hours of scans")}
      ${stat("Volatility", main?.m?.cv == null ? "–" : pct(main.m.cv), "day-to-day swing in value")}
    </div>
    <div class="chartbox">
      <div class="chartbar">
        <select id="c-house" aria-label="House"></select>
        <div class="tabs" id="c-range"><button data-r="h">Hourly · ${S.meta.settings.hourlyKeepHours / 24} days</button><button data-r="30">30 days</button><button data-r="365">A year</button></div>
        <label class="toggle"><input type="checkbox" id="c-qty"> Volume</label>
        <label class="toggle"><input type="checkbox" id="c-ma"> Moving average</label>
        <span class="note" id="c-note"></span>
      </div>
      <div id="chart"></div>
    </div>
    <div class="grid2 wide-left">
      <div><h2>Order book</h2><div class="chartbox"><div class="chartbar"><span class="note" id="d-note"></span></div><div id="depth"></div></div></div>
      <div><h2>Across houses</h2><div id="item-houses"></div></div>
    </div>
    <p class="note">The order book shows the cheapest current listings, stacked from the lowest price up: how many units you could buy before the price reaches each level. Sold per day and sell-through are estimated from auctions that vanish between scans, so sell-through errs low.</p>`;
  $("#v-sel", el)?.addEventListener("change", (e) => (location.hash = itemHref(region, e.target.value)));

  const sel = $("#c-house", el);
  $("#item-houses", el).replaceChildren(table([
    { key: "house", label: "House", html: (x) => houseLabel(x.hid), sort: (x) => x.hid },
    { key: "min", label: "Lowest", num: true, html: (x) => (x.m?.listed ? money(x.last[2]) : '<span class="muted">not listed</span>'), sort: (x) => (x.m?.listed ? x.last[2] : null) },
    { key: "mv", label: "Value", num: true, html: (x) => (x.m?.listed ? money(x.last[1]) : "–"), sort: (x) => (x.m?.listed ? x.last[1] : null) },
    { key: "qty", label: "Listed", num: true, html: (x) => (x.m?.listed ? x.last[3].toLocaleString() : "0"), sort: (x) => (x.m?.listed ? x.last[3] : 0) },
    { key: "spd", label: "Sold/day", num: true, html: (x) => fixed(x.m?.soldPerDay), sort: (x) => x.m?.soldPerDay },
    { key: "st", label: "Sell-thru", num: true, html: (x) => pct(x.m?.sellThrough), sort: (x) => x.m?.sellThrough },
    { key: "age", label: "Data age", num: true, html: (x) => freshness(house(x.hid)), sort: (x) => house(x.hid)?.dataTime ?? house(x.hid)?.lastScan },
  ], rows, { sortKey: "spd", onRow: (x) => { sel.value = x.hid; draw(); } }));

  sel.innerHTML = `${rows.length > 1 ? '<option value="all">All houses, side by side</option>' : ""}${rows.map((x) => `<option value="${x.hid}">${esc(factionName(house(x.hid)))} · ${esc(house(x.hid).groupName)}</option>`).join("")}`;
  sel.value = store.get("itemHouse", "all") === "all" && rows.length > 1 ? "all" : String(main?.hid ?? rows[0]?.hid);
  let range = store.get("range", "h");
  const qtyBox = $("#c-qty", el), maBox = $("#c-ma", el);
  qtyBox.checked = store.get("showVolume", true);
  maBox.checked = store.get("showMa", true);
  const axisBase = { stroke: "#b9aa8c", font: "14px Alegreya, Georgia, serif", grid: { stroke: "rgba(227,184,92,.10)" }, ticks: { stroke: "rgba(227,184,92,.25)" } };
  const fmt = (u, v) => (v == null ? "–" : money(v * 10000, { plain: true }));
  const gAxis = { ...axisBase, values: (u, vals) => vals.map((v) => `${+v.toFixed(4)}g`), size: 74 };

  const seriesOf = (x, which) => {
    // which: "h" hourly or day count. Returns { t, mv, mn, qty }
    if (which === "h") return { t: x.h.map((p) => p[0] * 3600), mv: x.h.map((p) => p[1] / 10000), mn: x.h.map((p) => p[2] / 10000), qty: x.h.map((p) => p[3]), sold: x.h.map((p) => p[5] ?? null) };
    const minDay = Math.floor(Date.now() / 86400000) - Number(which);
    const d = x.d.filter((r) => r[0] >= minDay);
    return { t: d.map((r) => r[0] * 86400), mv: d.map((r) => (r[1] == null ? null : r[1] / 10000)), mn: d.map((r) => (r[2] == null ? null : r[2] / 10000)), qty: d.map((r) => r[3]), sold: d.map((r) => r[4]) };
  };
  const movingAvg = (vals, n) => vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - n + 1), i + 1).filter((v) => v != null);
    return w.length >= Math.min(n, 3) ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });

  // Volume: units listed as a shaded band along the bottom (own scale, right axis) and estimated
  // units sold as bars (own scale, so a few sales still show next to thousands listed).
  const addVolume = (arr, series, axes, listed, sold) => {
    const maxL = Math.max(1, ...listed.filter((v) => v != null));
    arr.push(listed);
    series.push({ label: "Listed", stroke: "rgba(169,139,214,.9)", width: 1, fill: "rgba(169,139,214,.16)", scale: "q", points: { show: false }, value: (u, v) => (v == null ? "–" : `${v.toLocaleString()} units`) });
    axes.push({ ...axisBase, scale: "q", side: 1, grid: { show: false }, size: 62, values: (u, v) => v.map((n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : n)) });
    const scales = { q: { range: () => [0, maxL * 2.4] } };
    if (sold && sold.some((v) => v)) {
      const maxS = Math.max(1, ...sold.filter((v) => v != null));
      arr.push(sold);
      series.push({ label: "Sold (est.)", stroke: "#8fd49a", width: 1, fill: "rgba(143,212,154,.45)", scale: "s", paths: uPlot.paths.bars({ size: [0.6, 22] }), points: { show: false }, value: (u, v) => (v == null ? "–" : `${Math.round(v).toLocaleString()} units`) });
      scales.s = { range: () => [0, maxS * 3] };
    }
    return scales;
  };

  const draw = () => {
    store.set("itemHouse", sel.value === "all" ? "all" : "one");
    store.set("showVolume", qtyBox.checked);
    store.set("showMa", maBox.checked);
    for (const b of el.querySelectorAll("#c-range button")) b.classList.toggle("on", b.dataset.r === range);
    const box = $("#chart", el);
    chart?.destroy();
    chart = null;
    let opts, arr;
    const width = Math.max(300, box.clientWidth || el.clientWidth - 40);
    if (sel.value === "all") {
      // Every house's market value on one time axis.
      const per = rows.map((x) => ({ x, s: seriesOf(x, range) }));
      const ts = [...new Set(per.flatMap((p) => p.s.t))].sort((a, b) => a - b);
      const align = (p, k) => { const m = new Map(p.s.t.map((t, i) => [t, p.s[k]?.[i]])); return ts.map((t) => m.get(t) ?? null); };
      arr = [ts, ...per.map((p) => align(p, "mv"))];
      const series = [{}, ...per.map((p) => ({ label: `${factionName(house(p.x.hid))}`, stroke: FACTION_COLOR[house(p.x.hid).faction], width: 2, spanGaps: true, points: { show: false }, value: fmt }))];
      const axes = [axisBase, gAxis];
      let scales = { x: { time: true } };
      if (qtyBox.checked) {
        // Totals across all houses.
        const sum = (k) => { const cols = per.map((p) => align(p, k)); return ts.map((_, i) => (cols.some((c) => c[i] != null) ? cols.reduce((a, c) => a + (c[i] ?? 0), 0) : null)); };
        scales = { ...scales, ...addVolume(arr, series, axes, sum("qty"), sum("sold")) };
      }
      opts = { width, height: 360, series, axes, scales };
      $("#c-note", el).textContent = ts.length < 2 ? "Not enough history for this range yet: the chart fills in hour by hour." : `Market value in each house${qtyBox.checked ? "; volume is all houses combined" : ""}`;
    } else {
      const x = data.houses[sel.value];
      if (!x) { box.innerHTML = '<p class="empty">No history in this house yet.</p>'; return; }
      const s = seriesOf(x, range);
      arr = [s.t, s.mv, s.mn];
      const series = [{}, { label: "Market value", stroke: "#e3b85c", width: 2.5, fill: "rgba(227,184,92,.08)", points: { show: false }, value: fmt },
        { label: "Lowest listing", stroke: "#58a79c", width: 1.5, dash: [5, 4], points: { show: false }, value: fmt }];
      const axes = [axisBase, gAxis];
      if (maBox.checked) {
        arr.push(movingAvg(s.mv, range === "h" ? 24 : 7));
        series.push({ label: range === "h" ? "24h average" : "7-day average", stroke: "#f0e4c8", width: 1.5, dash: [2, 3], points: { show: false }, value: fmt });
      }
      let scales = { x: { time: true } };
      if (qtyBox.checked) scales = { ...scales, ...addVolume(arr, series, axes, s.qty, s.sold) };
      opts = { width, height: 360, series, axes, scales };
      $("#c-note", el).textContent = s.t.length < 2 ? "Not enough history for this range yet: the chart fills in hour by hour." : "";
    }
    chart = new uPlot({ ...opts, legend: { live: true }, cursor: { drag: { x: true, y: false } } }, arr, box);
    drawDepth();
  };

  const drawDepth = () => {
    const box = $("#depth", el);
    depth?.destroy();
    depth = null;
    const pick = sel.value === "all" ? rows.filter((x) => x.l?.length) : [data.houses[sel.value] && { hid: Number(sel.value), ...data.houses[sel.value] }].filter((x) => x?.l?.length);
    if (!pick.length) { box.innerHTML = '<p class="empty">Nothing listed right now.</p>'; $("#d-note", el).textContent = ""; return; }
    // Shared x: cumulative units. Each house gets a stepped price curve.
    const curves = pick.map((x) => { let c = 0; return { x, pts: x.l.map(([u, q]) => [(c += q), u / 10000]) }; });
    const xs = [0, ...new Set(curves.flatMap((c) => c.pts.map((p) => p[0])))].sort((a, b) => a - b);
    const arr = [xs, ...curves.map((c) => xs.map((q) => { const p = c.pts.find((pt) => pt[0] >= q); return p ? p[1] : null; }))];
    depth = new uPlot({
      width: Math.max(280, box.clientWidth || 400), height: 240,
      series: [{ label: "Units", value: (u, v) => (v == null ? "–" : `${v.toLocaleString()} units`) }, ...curves.map((c) => ({ label: factionName(house(c.x.hid)), stroke: FACTION_COLOR[house(c.x.hid).faction], width: 2, fill: `${FACTION_COLOR[house(c.x.hid).faction]}22`, paths: uPlot.paths.stepped({ align: -1 }), points: { show: false }, value: fmt }))],
      axes: [{ ...axisBase, values: (u, v) => v.map((n) => n.toLocaleString()) }, gAxis], scales: { x: { time: false } }, legend: { live: true },
    }, arr, box);
    $("#d-note", el).textContent = `Cheapest ${Math.max(...pick.map((x) => x.l.length))} listings`;
  };

  sel.addEventListener("change", draw);
  qtyBox.addEventListener("change", draw);
  maBox.addEventListener("change", draw);
  $("#c-range", el).addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { range = b.dataset.r; store.set("range", range); draw(); } });
  $("#w-btn", el).addEventListener("click", () => {
    const i = S.watch.findIndex((w) => w.region === region && w.key === vkey);
    if (i >= 0) S.watch.splice(i, 1);
    else S.watch.push({ region, key: vkey, target: $("#w-target", el).value ? goldToCopper($("#w-target", el).value) : null });
    store.set("watch", S.watch);
    route();
  });
  $("#w-target", el).addEventListener("change", (e) => {
    const w = S.watch.find((w) => w.region === region && w.key === vkey);
    if (w) { w.target = e.target.value ? goldToCopper(e.target.value) : null; store.set("watch", S.watch); }
  });
  requestAnimationFrame(draw);
  itemExtras(el, base, file, houses().map((h) => h.id)).catch(() => {});
}

// ---------- market (latest snapshot, every item) ----------
async function loadMarket() {
  const [m, idx] = await Promise.all([load(`market-${S.region}.json`), index()]);
  const hids = m.houses;
  return { hids, idx, rows: m.rows.map((r) => {
    const info = idx.get(baseOf(r[0])) ?? { name: `Item ${baseOf(r[0])}`, q: "COMMON" };
    const per = r[1];
    const mins = per.filter(Boolean).map((p) => p[0]);
    const lo = Math.min(...mins), hi = Math.max(...mins);
    return { key: r[0], info, per, base: r[2], chg24: r[3], chg7: r[4], spd: r[5], st: r[6], cv: r[7], gold: r[8], supply: r[9], spark: r[10],
      main: r[11] ?? 0, mainLo: per[r[11] ?? 0]?.[0] ?? null, lo, qty: per.reduce((s, p) => s + (p?.[2] ?? 0), 0), spread: mins.length > 1 && lo > 0 ? hi / lo - 1 : null, mv: Math.max(...per.filter(Boolean).map((p) => p[1])) };
  }) };
}

async function viewMarket(el) {
  const { hids, idx, rows } = await loadMarket();
  const classes = [...new Set([...idx.values()].map((i) => i.cls).filter(Boolean))].sort();
  const f = store.get("mktFilters", { q: "", cls: "", qual: "", minSpd: "", minPrice: "", maxPrice: "", minSpread: "" });
  el.innerHTML = `
    <h1 class="illumined">Market</h1>
    <p class="lead">Every item on the ${esc(scopeName())} auction houses, at the latest prices Blizzard has published. Prices are per unit. Trend lines cover the last ${S.meta.settings.hourlyKeepHours / 24} days of the busiest house.</p>
    <p class="freshness">Data age: ${hids.map((h) => `<span>${esc(factionName(house(h) ?? { faction: "unknown" }))} ${freshness(house(h))}</span>`).join("")} <span class="note">Checked hourly.</span></p>
    <div class="filters">
      <label>Item<input id="m-q" type="search" placeholder="name or item id"></label>
      <label>Kind<select id="m-cls"><option value="">Everything</option>${classes.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
      <label>Quality<select id="m-qual"><option value="">Any</option>${["POOR", "COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"].map((q) => `<option value="${q}">${q[0] + q.slice(1).toLowerCase()}</option>`).join("")}</select></label>
      <label>Min sold/day<input id="m-minSpd" type="number" min="0" step="0.5"></label>
      <label>Min price (g)<input id="m-minPrice" type="number" min="0" step="0.1"></label>
      <label>Max price (g)<input id="m-maxPrice" type="number" min="0" step="1"></label>
      <label>House gap ≥ %<input id="m-minSpread" type="number" min="0" step="5" title="Difference between the cheapest and dearest house's lowest listing"></label>
    </div>
    <div id="m-table"></div>`;
  for (const [k, v] of Object.entries(f)) { const i = $(`#m-${k}`, el); if (i) i.value = v; }
  const hcol = (hid, i) => {
    const h = house(hid);
    return { key: `h${i}`, label: h ? factionName(h) : `#${hid}`, num: true, title: "Lowest listing (value underneath)",
      html: (r) => (r.per[i] ? `${money(r.per[i][0])}<div class="sub">${r.per[i][2].toLocaleString()} listed${r.per[i][1] !== r.per[i][0] ? `, worth ${money(r.per[i][1], { plain: true })}` : ""}</div>` : '<span class="muted">–</span>'),
      sort: (r) => r.per[i]?.[0] };
  };
  const draw = () => {
    for (const k of Object.keys(f)) f[k] = $(`#m-${k}`, el).value;
    store.set("mktFilters", f);
    const q = f.q.trim().toLowerCase();
    const out = rows.filter((r) =>
      (!q || r.info.name.toLowerCase().includes(q) || r.key === q || baseOf(r.key) === q) &&
      (!f.cls || r.info.cls === f.cls) && (!f.qual || r.info.q === f.qual) &&
      (!f.minSpd || (r.spd ?? 0) >= Number(f.minSpd)) &&
      (!f.minPrice || r.lo >= goldToCopper(f.minPrice)) && (!f.maxPrice || r.lo <= goldToCopper(f.maxPrice)) &&
      (!f.minSpread || (r.spread ?? 0) * 100 >= Number(f.minSpread)));
    $("#m-table", el).replaceChildren(table([
      { key: "name", label: "Item", html: (r) => itemCell(r.info.name, r.info.q, r.info.icon, bonusOf(r.key) ? `variant ${bonusOf(r.key)}` : esc(r.info.cls ?? "")), sort: (r) => r.info.name },
      ...hids.map(hcol),
      { key: "qty", label: "Listed", num: true, title: "Units listed across all houses", html: (r) => r.qty.toLocaleString(), sort: (r) => r.qty },
      { key: "spread", label: "Gap", num: true, title: "How much dearer the dearest house's lowest listing is than the cheapest house's", html: (r) => (r.spread == null ? "–" : pct(r.spread)), sort: (r) => r.spread },
      { key: "spd", label: "Sold/day", num: true, html: (r) => fixed(r.spd), sort: (r) => r.spd },
      { key: "gold", label: "Traded/day", num: true, title: "Estimated gold changing hands per day", html: (r) => money(r.gold), sort: (r) => r.gold },
      { key: "chg24", label: "24h", num: true, html: (r) => signed(r.chg24), sort: (r) => r.chg24 },
      { key: "chg7", label: "7d", num: true, html: (r) => signed(r.chg7), sort: (r) => r.chg7 },
      { key: "spark", label: "Trend", html: (r) => sparkline(r.spark) },
    ], out, { sortKey: rows.some((r) => r.gold) ? "gold" : "qty", onRow: (r) => (location.hash = itemHref(S.region, r.key)), empty: "No items match these filters.", limit: 200 }));
  };
  let t;
  el.addEventListener("input", (e) => { if (e.target.closest(".filters")) { clearTimeout(t); t = setTimeout(draw, 150); } });
  draw();
}

// ---------- trends ----------
let pulseChart = null;
async function viewTrends(el) {
  const [{ rows }, pulse] = await Promise.all([loadMarket(), load(`pulse-${S.region}.json`)]);
  const minSpd = store.get("trendMinSpd", 1);
  const hrs = S.meta.regions[S.region].historyHours ?? 0;
  el.innerHTML = `
    <h1 class="illumined">Trends</h1>
    <p class="lead">What's moving on the ${esc(scopeName())} houses. Lists only include items selling at least the amount below, so one-off listings don't crowd them out.</p>
    <div class="filters"><label>Min sold/day<input id="t-min" type="number" min="0" step="0.5" value="${minSpd}"></label>
      <span class="note">${hrs < 24 ? `History so far: ${hrs} hour${hrs === 1 ? "" : "s"}. 24-hour moves need a day of scans, 7-day moves a week.` : `History so far: ${Math.floor(hrs / 24)} days.`}</span></div>
    <div class="chartbox"><div class="chartbar"><b class="chart-title">Market activity</b><span class="note">Listings on each house, hour by hour</span></div><div id="pulse"></div></div>
    <div class="grid2 lists" id="t-lists"></div>`;
  // Pulse chart.
  const ts = [...new Set(pulse.houses.flatMap((h) => h.hours.map((p) => p[0])))].sort((a, b) => a - b);
  const box = $("#pulse", el);
  pulseChart?.destroy();
  pulseChart = null;
  if (ts.length < 2) box.innerHTML = '<p class="empty">The activity chart starts after the second hourly scan.</p>';
  else {
    const axis = { stroke: "#b9aa8c", font: "14px Alegreya, Georgia, serif", grid: { stroke: "rgba(227,184,92,.10)" }, ticks: { stroke: "rgba(227,184,92,.25)" } };
    pulseChart = new uPlot({
      width: Math.max(300, box.clientWidth || el.clientWidth - 40), height: 260,
      series: [{}, ...pulse.houses.map((h) => ({ label: factionName(house(h.id) ?? { faction: "unknown" }), stroke: FACTION_COLOR[house(h.id)?.faction ?? "unknown"], width: 2, points: { show: false }, value: (u, v) => (v == null ? "–" : v.toLocaleString()) }))],
      axes: [axis, { ...axis, size: 70, values: (u, v) => v.map((n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : n)) }], scales: { x: { time: true } },
    }, [ts.map((t) => t * 3600), ...pulse.houses.map((h) => { const m = new Map(h.hours.map((p) => [p[0], p[2]])); return ts.map((t) => m.get(t) ?? null); })], box);
  }
  const draw = () => {
    const min = Number($("#t-min", el).value || 0);
    store.set("trendMinSpd", min);
    const liquid = rows.filter((r) => (r.spd ?? 0) >= min);
    const list = (title, why, items, metric) => `<div><h2>${title}</h2><p class="note" style="margin:-6px 0 10px">${why}</p><div class="tablewrap compact"><table><tbody>${items.slice(0, 10).map((r) => `
      <tr onclick="location.hash='${itemHref(S.region, r.key)}'"><td>${itemCell(r.info.name, r.info.q, r.info.icon, bonusOf(r.key) ? `variant ${bonusOf(r.key)}` : "")}</td><td class="num">${money(r.mv)}</td><td class="num">${metric(r)}</td><td>${sparkline(r.spark, { w: 84, h: 24 })}</td></tr>`).join("") || '<tr><td class="empty">Nothing yet: this list fills in as history builds up.</td></tr>'}</tbody></table></div></div>`;
    const by = (k, dir = -1) => (a, b) => ((a[k] ?? 0) - (b[k] ?? 0)) * -dir;
    $("#t-lists", el).innerHTML = [
      list("Rising today", "Biggest 24-hour gains in market value", liquid.filter((r) => r.chg24 > 0).sort(by("chg24")), (r) => signed(r.chg24)),
      list("Falling today", "Biggest 24-hour drops: possible buying chances", liquid.filter((r) => r.chg24 < 0).sort(by("chg24", 1)), (r) => signed(r.chg24)),
      list("Rising this week", "Biggest 7-day gains", liquid.filter((r) => r.chg7 > 0).sort(by("chg7")), (r) => signed(r.chg7)),
      list("Falling this week", "Biggest 7-day drops", liquid.filter((r) => r.chg7 < 0).sort(by("chg7", 1)), (r) => signed(r.chg7)),
      list("Most gold traded", "Estimated gold changing hands per day", liquid.filter((r) => r.gold).sort(by("gold")), (r) => money(r.gold)),
      list("Supply squeeze", "Far fewer listed than usual while sales hold up: prices may rise", liquid.filter((r) => r.supply != null && r.supply < 0.6).sort(by("supply", 1)), (r) => `${pct(r.supply)} of usual`),
      list("Under baseline now", "Lowest listing in the busiest house well below its usual value", liquid.filter((r) => r.base && r.mainLo && r.mainLo / r.base < 0.8).sort((a, b) => a.mainLo / a.base - b.mainLo / b.base), (r) => pct(r.mainLo / r.base - 1)),
      list("Most volatile", "Biggest day-to-day swings: room for timing, more risk", liquid.filter((r) => r.cv != null).sort(by("cv")), (r) => pct(r.cv)),
    ].join("");
  };
  $("#t-min", el).addEventListener("input", draw);
  draw();
}

// ---------- crafting ----------
async function loadRecipes() {
  try { return await load(`recipes-${S.region}.json`); } catch { return null; }
}
const reagentLabel = (R, id, n) => {
  const nm = R.names[id] ?? [];
  const vendor = nm[3] != null;
  return `<span class="reagent">${n}× <span class="q-${esc(nm[1] ?? "COMMON")}">${esc(nm[0] ?? `Item ${id}`)}</span>${vendor ? ' <span class="tag" title="Priced at the vendor (trade supplies). Edit config/vendor-reagents.json to change.">vendor</span>' : ""}</span>`;
};

async function viewCrafting(el) {
  const R = await loadRecipes();
  if (!R) { el.innerHTML = '<h1 class="illumined">Crafting</h1><p class="empty">Recipe data arrives with the next collection run.</p>'; return; }
  const f = store.get("craftFilters", { prof: "", house: String(R.houses[0]), q: "", minSpd: "", onlyProfit: "1" });
  if (!R.houses.map(String).includes(f.house)) f.house = String(R.houses[0]);
  const profs = Object.entries(R.professions).filter(([id]) => R.rows.some((r) => String(r[2]) === id && r[4])).sort((a, b) => a[1].name.localeCompare(b[1].name));
  el.innerHTML = `
    <h1 class="illumined">Crafting</h1>
    <p class="lead">Every recipe from Blizzard's API, priced at today's market: reagents at market value (or the vendor price for trade supplies), the product at its market value after the ${pct(S.meta.fees.cutRate, 0)} AH cut. Profit is per craft. For trades sized to what actually sells, see crafting on the Opportunities page.</p>
    <div class="filters">
      <label>Profession<select id="cf-prof"><option value="">All</option>${profs.map(([id, p]) => `<option value="${id}">${esc(p.name)}</option>`).join("")}</select></label>
      <label>House<select id="cf-house">${R.houses.map((h) => `<option value="${h}">${esc(factionName(house(h) ?? { faction: "unknown" }))}</option>`).join("")}</select></label>
      <label>Recipe or item<input id="cf-q" type="search" placeholder="filter by name"></label>
      <label>Min sold/day<input id="cf-minSpd" type="number" min="0" step="0.5"></label>
      <label>Show<select id="cf-onlyProfit"><option value="1">Profitable only</option><option value="">Everything priced</option><option value="all">All recipes</option></select></label>
    </div>
    <div id="cf-table"></div>
    <p class="note">Recipes source: Blizzard Game Data API (WoW: Forever), ${S.meta.catalog?.recipes ?? "?"} recipes, build ${esc(S.meta.catalog?.build ?? "?")}. Recipes with no product (enchants) are left out of profit. Vendor-priced reagents follow <code>config/vendor-reagents.json</code>.</p>`;
  for (const [k, v] of Object.entries(f)) { const i = $(`#cf-${k}`, el); if (i) i.value = v; }
  const draw = () => {
    for (const k of Object.keys(f)) f[k] = $(`#cf-${k}`, el).value;
    store.set("craftFilters", f);
    const hi = R.houses.map(String).indexOf(f.house);
    const q = f.q.trim().toLowerCase();
    const rows = R.rows.filter((r) => r[4]).map((r) => {
      const [cost, value, profit, spd] = r[7][hi] ?? [];
      const nm = R.names[r[4]] ?? [];
      return { r, cost, value, profit, spd, margin: profit != null && cost ? profit / cost : null, name: nm[0] ?? r[1], q: nm[1] ?? "COMMON", icon: nm[2] };
    }).filter((x) =>
      (!f.prof || String(x.r[2]) === f.prof) &&
      (!q || x.name.toLowerCase().includes(q) || x.r[1].toLowerCase().includes(q)) &&
      (!f.minSpd || (x.spd ?? 0) >= Number(f.minSpd)) &&
      (f.onlyProfit === "all" || (f.onlyProfit === "1" ? x.profit > 0 : x.cost != null && x.value != null)));
    $("#cf-table", el).replaceChildren(table([
      { key: "name", label: "Makes", html: (x) => itemCell(x.name, x.q, x.icon, `${esc(R.professions[x.r[2]]?.name ?? "")} · ${esc(x.r[3] ?? "")}${x.r[5] !== 1 ? ` · ${x.r[5]} per craft` : ""}`), sort: (x) => x.name },
      { key: "reagents", label: "Reagents", html: (x) => `<div class="reagents">${x.r[6].map(([id, n]) => reagentLabel(R, id, n)).join("")}</div>` },
      { key: "cost", label: "Cost", num: true, title: "Reagents for one craft", html: (x) => (x.cost == null ? '<span class="muted" title="A reagent has no market price here">can’t price</span>' : money(x.cost)), sort: (x) => x.cost },
      { key: "value", label: "Sells for", num: true, title: "Market value of one craft's output, before the AH cut", html: (x) => (x.value == null ? '<span class="muted">not listed</span>' : money(x.value * x.r[5])), sort: (x) => (x.value == null ? null : x.value * x.r[5]) },
      { key: "profit", label: "Profit", num: true, title: "Per craft, after the AH cut", html: (x) => (x.profit == null ? "–" : `<b class="${x.profit >= 0 ? "pos" : "neg"}">${money(x.profit)}</b>`), sort: (x) => x.profit },
      { key: "margin", label: "Margin", num: true, html: (x) => (x.margin == null ? "–" : pct(x.margin)), sort: (x) => x.margin },
      { key: "spd", label: "Sold/day", num: true, html: (x) => fixed(x.spd), sort: (x) => x.spd },
      { key: "verdict", label: "", html: (x) => (x.profit == null ? "" : x.profit > 0 ? '<span class="pill t-craft">Craft it</span>' : '<span class="pill t-buy">Buy it</span>') },
    ], rows, { sortKey: "profit", onRow: (x) => (location.hash = itemHref(S.region, String(x.r[4]))), empty: "No recipes match. Try “Everything priced” or another house.", limit: 150 }));
  };
  el.addEventListener("input", (e) => { if (e.target.closest(".filters")) draw(); });
  draw();
}

/** Crafting + disenchanting sections for the item page. */
async function itemExtras(el, base, file, houseIds) {
  const [R, spec] = await Promise.all([loadRecipes(), loadSpec()]);
  const out = [];
  const id = Number(base);
  const sig = (spec ?? []).filter((s) => baseOf(s.key) === String(base)).sort((a, b) => b.score - a.score)[0];
  if (sig) {
    el.querySelector(".itemhead")?.insertAdjacentHTML("afterend", `<a class="frame specflag" href="#/spec">
      <div>${scoreBar(sig)}</div>
      <div><b>Speculation signal</b> ${confPill(sig.confidence)} <span class="note">in ${esc(factionName(house(sig.house) ?? { faction: "unknown" }))}</span><br>
      <span class="note">Listed ${sig.qtyNow.toLocaleString()} vs usual ${sig.qtyBase.toLocaleString()} (${pctSigned(sig.supplyChange)}), value ${pctSigned(sig.priceChange)}, ${fixed(sig.soldR)} sold/day${sig.absorption != null ? `, buyers taking ${sig.absorption.toFixed(1)}× new supply` : ""}${sig.buyouts ? `, ${sig.buyouts} big buyout hour${sig.buyouts > 1 ? "s" : ""}` : ""}.</span></div></a>`);
  }
  if (R) {
    const made = R.rows.filter((r) => r[4] === id);
    const used = R.rows.filter((r) => r[6].some(([rid]) => rid === id));
    if (made.length) {
      out.push(`<div><h2>Crafted by</h2>${made.map((r) => `<div class="frame recipebox">
        <div class="recipe-head"><b>${esc(r[1])}</b> <span class="note">${esc(R.professions[r[2]]?.name ?? "")}${r[5] !== 1 ? ` · makes ${r[5]}` : ""}</span></div>
        <div class="reagents">${r[6].map(([rid, n]) => `<a href="${itemHref(S.region, String(rid))}">${reagentLabel(R, rid, n)}</a>`).join("")}</div>
        <table class="mini"><thead><tr><th>House</th><th class="num">Reagents</th><th class="num">Sells for</th><th class="num">Profit</th></tr></thead><tbody>
        ${R.houses.map((h, i) => { const [cost, value, profit] = r[7][i] ?? []; return `<tr><td>${houseLabel(h)}</td><td class="num">${cost == null ? '<span class="muted">can’t price</span>' : money(cost)}</td><td class="num">${value == null ? "–" : money(value * r[5])}</td><td class="num">${profit == null ? "–" : `<b class="${profit >= 0 ? "pos" : "neg"}">${money(profit)}</b>`}</td></tr>`; }).join("")}
        </tbody></table></div>`).join("")}</div>`);
    }
    if (used.length) {
      out.push(`<div><h2>Used in</h2><div class="tablewrap compact"><table><tbody>${used.slice(0, 30).map((r) => {
        const nm = R.names[r[4]] ?? [];
        const n = r[6].find(([rid]) => rid === id)[1];
        const best = Math.max(...r[7].map((p) => p[2] ?? -Infinity));
        return `<tr onclick="location.hash='${r[4] ? itemHref(S.region, String(r[4])) : ""}'"><td>${r[4] ? itemCell(nm[0] ?? r[1], nm[1] ?? "COMMON", nm[2], `${esc(R.professions[r[2]]?.name ?? "")} · needs ${n}`) : `${esc(r[1])}<div class="sub">${esc(R.professions[r[2]]?.name ?? "")} · needs ${n}</div>`}</td><td class="num">${Number.isFinite(best) ? `<span class="${best >= 0 ? "pos" : "neg"}">${money(best)}</span>` : "–"}</td></tr>`;
      }).join("")}</tbody></table></div>${used.length > 30 ? `<p class="note">and ${used.length - 30} more</p>` : ""}</div>`);
    }
  }
  if (file.de) {
    const de = file.de;
    out.push(`<div><h2>Disenchants into</h2><div class="frame recipebox">
      <table class="mini"><thead><tr><th>Material</th><th class="num">Chance</th><th class="num">Quantity</th>${houseIds.map((h) => `<th class="num">${esc(factionName(house(h) ?? { faction: "unknown" }))}</th>`).join("")}</tr></thead><tbody>
      ${de.outs.map(([mid, name, p, lo, hi], i) => `<tr><td>${mid ? `<a href="${itemHref(S.region, String(mid))}">${esc(name)}</a>` : esc(name)}</td><td class="num">${pct(p, p < 0.01 ? 1 : 0)}</td><td class="num">${lo === hi ? lo : `${lo}–${hi}`}</td>${houseIds.map((h) => `<td class="num">${money(de.houses[h]?.[1]?.[i])}</td>`).join("")}</tr>`).join("")}
      <tr class="total"><td colspan="3"><b>Expected value per item</b> <span class="note">after the AH cut</span></td>${houseIds.map((h) => `<td class="num"><b>${money(de.houses[h]?.[0])}</b></td>`).join("")}</tr>
      </tbody></table>
      <p class="note">Item level ${de.lvl}. ${esc(S.meta.deSource ?? "Classic disenchanting tables, unverified for Forever")}. Blizzard publishes no disenchant data, so these odds may differ in Forever.</p></div></div>`);
  }
  if (out.length) el.insertAdjacentHTML("beforeend", `<div class="grid2 extras">${out.join("")}</div>`);
}

// ---------- speculation ----------
async function loadSpec() {
  try { return await load(`spec-${S.region}.json`); } catch { return null; }
}
const scoreBar = (s) => `<div class="scorebar" title="Speculation score ${s.score}/100"><span style="width:${s.score}%"></span><b>${s.score}</b></div>`;
const confPill = (c) => `<span class="conf conf-${c}" title="How much data backs this signal">${c}</span>`;
const pctSigned = (x) => (x == null ? "–" : `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`);

async function viewSpec(el) {
  const [rows, idx] = await Promise.all([loadSpec(), index()]);
  const f = store.get("specFilters", { minScore: 40, conf: "low", minSpd: "", q: "" });
  const bt = S.meta.backtest?.speculation;
  el.innerHTML = `
    <h1 class="illumined">Speculation watch</h1>
    <p class="lead">Items that look like they're being bought up or squeezed before a price move: listings draining away while sales hold, buyers taking more than sellers post, price starting to climb. Scores combine five signals; confidence reflects how much data backs them.</p>
    <div class="cards">
      <div class="card"><div class="k">Signals now</div><div class="v">${rows?.length ?? 0}</div><div class="note">${(rows ?? []).filter((s) => s.score >= 70).length} strong (70+)</div></div>
      <div class="card"><div class="k">Track record</div><div class="v">${bt?.evaluated ? pct(bt.hitRate) : "–"}</div><div class="note">${bt?.evaluated ? `of ${bt.evaluated} flagged items rose ${pct(bt.rise)}+ within ${bt.days} days` : `checked ${bt?.days ?? 3} days after each flag; ${bt?.pending ?? 0} pending`}</div></div>
      <div class="card"><div class="k">Average peak gain</div><div class="v">${bt?.avgPeakRise == null ? "–" : `+${Math.round(bt.avgPeakRise * 100)}%`}</div><div class="note">for flags that hit</div></div>
    </div>
    <div class="filters">
      <label>Min score<input id="sp-minScore" type="number" min="0" max="100" step="5"></label>
      <label>Confidence<select id="sp-conf"><option value="low">Any</option><option value="medium">Medium or high</option><option value="high">High only</option></select></label>
      <label>Min sold/day<input id="sp-minSpd" type="number" min="0" step="0.5"></label>
      <label>Item<input id="sp-q" type="search" placeholder="filter by name"></label>
    </div>
    <div id="sp-table"></div>
    <details class="note explain"><summary>How the score works</summary>
      <p>Each item is compared with its own usual level in the same house. Supply drain (35 points): units listed now versus usual. Demand holding (20): sales per day lately versus before. Price rising (20): market value now versus usual, full marks at +25%. Absorption (15): units bought versus genuinely new units posted, full marks when buyers take twice the new supply (reposts don't count as new). Scarcity (10): days of supply left at the recent sales rate. Big buyouts count hours where sales took at least a fifth of what was listed.</p>
      <p>Until there are 7 days of history the comparison uses the last few hours against the previous 1–3 days; after that, days against the week before. An item is listed when supply is down at least 25% or buyers take at least 1.3× the new supply, and it scores 40+.</p></details>`;
  for (const [k, v] of Object.entries(f)) { const i = $(`#sp-${k}`, el); if (i) i.value = v; }
  const rank = { low: 0, medium: 1, high: 2 };
  const draw = () => {
    for (const k of Object.keys(f)) f[k] = $(`#sp-${k}`, el).value;
    store.set("specFilters", f);
    const q = f.q.trim().toLowerCase();
    const list = (rows ?? []).map((s) => ({ ...s, info: idx.get(baseOf(s.key)) ?? { name: `Item ${s.key}`, q: "COMMON" } })).filter((s) =>
      s.score >= Number(f.minScore || 0) && rank[s.confidence] >= rank[f.conf] && (!f.minSpd || (s.soldR ?? 0) >= Number(f.minSpd)) && (!q || s.info.name.toLowerCase().includes(q)));
    $("#sp-table", el).replaceChildren(table([
      { key: "name", label: "Item", html: (s) => itemCell(s.info.name, s.info.q, s.info.icon, houseLabel(s.house)), sort: (s) => s.info.name },
      { key: "score", label: "Signal", html: (s) => `${scoreBar(s)} ${confPill(s.confidence)}`, sort: (s) => s.score },
      { key: "supply", label: "Listed", num: true, title: "Units listed now (usual underneath)", html: (s) => `<span class="${s.supplyChange <= -0.25 ? "neg" : ""}">${s.qtyNow.toLocaleString()}</span><div class="sub">usual ${s.qtyBase.toLocaleString()} · ${pctSigned(s.supplyChange)}</div>`, sort: (s) => s.supplyChange },
      { key: "qtyspark", label: "Supply", html: (s) => sparkline(s.sparkQty, { w: 90, h: 24 }) },
      { key: "price", label: "Value", num: true, html: (s) => `${money(s.mvNow)}<div class="sub">${pctSigned(s.priceChange)} vs usual</div>`, sort: (s) => s.priceChange },
      { key: "mvspark", label: "Price", html: (s) => sparkline(s.sparkMv, { w: 90, h: 24 }) },
      { key: "sold", label: "Sold/day", num: true, html: (s) => `${fixed(s.soldR)}<div class="sub">${s.soldB == null ? "no earlier data" : `was ${fixed(s.soldB)}`}</div>`, sort: (s) => s.soldR },
      { key: "abs", label: "Bought vs posted", num: true, title: "Units bought per unit newly posted (reposts excluded)", html: (s) => (s.absorption == null ? "–" : `<span class="${s.absorption >= 1.3 ? "pos" : ""}">${s.absorption.toFixed(1)}×</span>`), sort: (s) => s.absorption },
      { key: "dos", label: "Days left", num: true, title: "Days of supply at the recent sales rate", html: (s) => (s.daysOfSupply == null ? "–" : s.daysOfSupply < 0.05 ? '<span class="neg">sold out</span>' : fixed(s.daysOfSupply)), sort: (s) => s.daysOfSupply },
      { key: "buyouts", label: "Buyouts", num: true, title: "Hours with a big buyout in the last day", html: (s) => (s.buyouts ? `<b>${s.buyouts}</b>` : "–"), sort: (s) => s.buyouts },
    ], list, { sortKey: "score", onRow: (s) => (location.hash = itemHref(S.region, s.key)), empty: rows?.length ? "Nothing matches these filters." : "No signals right now. Signals need a couple of days of hourly scans and sales tracking." }));
  };
  el.addEventListener("input", (e) => { if (e.target.closest(".filters")) draw(); });
  draw();
}

async function viewHouses(el) {
  const all = S.meta.regions[S.region].allHouses ?? houses();
  const tracked = new Set(houses().map((h) => h.id));
  const groups = [...new Set(all.map((h) => h.group))].sort((a, b) => (tracked.has(all.find((h) => h.group === b).id) ? 1 : 0) - (tracked.has(all.find((h) => h.group === a).id) ? 1 : 0) || a - b);
  el.innerHTML = `<h1 class="illumined">Auction houses</h1>
    <p class="lead">Each ruleset has its own Alliance, Horde and Blackwater (neutral) house. Only the ${esc(scopeName())} houses are scanned; the others are listed so you can see the layout. Change the tracked groups in <code>config/settings.json</code>.</p>
    ${groups.map((g) => `<h2>${esc(all.find((h) => h.group === g).groupName)}</h2><div class="grid2">${all.filter((h) => h.group === g).map((h) => {
      const t = houses().find((x) => x.id === h.id);
      return t ? `<a class="housecard" href="#/house/${S.region}/${h.id}"><span class="fac ${h.faction}">${esc(h.name)}</span>
        <div class="note">${t.listings ? `${t.listings.toLocaleString()} listings, ${t.items.toLocaleString()} items tracked` : "empty"} · data ${freshness(t)}</div></a>`
        : `<div class="housecard" style="opacity:.55"><span class="fac ${h.faction}">${esc(h.name)}</span><div class="note">#${h.id} · not tracked</div></div>`;
    }).join("")}</div>`).join("")}`;
}

async function viewHouse(el, region, hid) {
  if (region !== S.region) setRegion(region);
  const [d, idx] = await Promise.all([load(`houses/${region}-${hid}.json`), index()]);
  const h = house(hid) ?? d.house;
  const rows = d.rows.map((r) => ({ key: r[0], min: r[1], mv: r[2], qty: r[3], n: r[4], base: r[5], spd: r[6], st: r[7], chg: r[8], info: idx.get(baseOf(r[0])) ?? { name: `Item ${r[0]}`, q: "COMMON" } }));
  const movers = rows.filter((r) => r.chg != null && (r.spd ?? 0) >= 1);
  const up = [...movers].sort((a, b) => b.chg - a.chg).slice(0, 8);
  const down = [...movers].sort((a, b) => a.chg - b.chg).slice(0, 8);
  const moverList = (list) => `<div class="tablewrap"><table><tbody>${list.map((r) => `<tr onclick="location.hash='${itemHref(region, r.key)}'"><td>${itemCell(r.info.name, r.info.q, r.info.icon)}</td><td class="num">${money(r.mv)}</td><td class="num">${signed(r.chg)}</td></tr>`).join("") || '<tr><td class="empty">Needs 24h of history.</td></tr>'}</tbody></table></div>`;
  el.innerHTML = `<h1 class="illumined">${esc(h.name)}</h1><p class="lead" style="margin-bottom:6px"><span class="fac ${h.faction}">${esc(h.groupName)}</span> #${h.id} · ${region.toUpperCase()}</p>
    <p class="lead">${rows.length.toLocaleString()} items listed · scanned ${ago(h.lastScan)}</p>
    <div class="grid2"><div><h2>Rising (24h, ≥1 sold/day)</h2>${moverList(up)}</div><div><h2>Falling</h2>${moverList(down)}</div></div>
    <h2>Market</h2><div class="filters"><label>Item<input id="h-q" type="search" placeholder="filter by name"></label></div><div id="h-table"></div>`;
  const draw = () => {
    const q = $("#h-q", el).value.trim().toLowerCase();
    $("#h-table", el).replaceChildren(table([
      { key: "name", label: "Item", html: (r) => itemCell(r.info.name, r.info.q, r.info.icon, bonusOf(r.key) ? `variant ${bonusOf(r.key)}` : ""), sort: (r) => r.info.name },
      { key: "min", label: "Min buyout", num: true, html: (r) => money(r.min), sort: (r) => r.min },
      { key: "mv", label: "Market value", num: true, html: (r) => money(r.mv), sort: (r) => r.mv },
      { key: "base", label: "Baseline", num: true, html: (r) => money(r.base), sort: (r) => r.base },
      { key: "vs", label: "MV vs base", num: true, html: (r) => signed(r.base ? r.mv / r.base - 1 : null), sort: (r) => (r.base ? r.mv / r.base : null) },
      { key: "qty", label: "Listed", num: true, html: (r) => r.qty.toLocaleString(), sort: (r) => r.qty },
      { key: "spd", label: "Sold/day", num: true, html: (r) => fixed(r.spd), sort: (r) => r.spd },
      { key: "st", label: "Sell-through", num: true, html: (r) => pct(r.st), sort: (r) => r.st },
      { key: "chg", label: "24h", num: true, html: (r) => signed(r.chg), sort: (r) => r.chg },
    ], rows.filter((r) => !q || r.info.name.toLowerCase().includes(q)), { sortKey: "spd", onRow: (r) => (location.hash = itemHref(region, r.key)) }));
  };
  $("#h-q", el).addEventListener("input", draw);
  draw();
}

async function viewWatch(el) {
  const idx = await index();
  const mine = S.watch.filter((w) => w.region === S.region);
  el.innerHTML = `<h1 class="illumined">Watchlist</h1><p class="lead">Saved in this browser. Targets here are highlighted on this page only; for Discord alerts, add a rule to <code>config/alerts.json</code> in the repo.</p><div id="w-table"></div>`;
  const rows = await Promise.all(mine.map(async (w) => {
    let best = null;
    try {
      const f = await load(`items/${w.region}/${baseOf(w.key)}.json`);
      for (const [hid, v] of Object.entries(f.variants[w.key] ?? {})) {
        if (!v.m?.listed || !inGroup(hid)) continue;
        const last = v.h.at(-1);
        if (!best || last[2] < best.min) best = { hid: Number(hid), min: last[2], mv: last[1], base: v.m.baseline, spd: v.m.soldPerDay };
      }
    } catch { /* not listed */ }
    return { ...w, info: idx.get(baseOf(w.key)) ?? { name: `Item ${w.key}`, q: "COMMON" }, best };
  }));
  $("#w-table", el).replaceChildren(table([
    { key: "name", label: "Item", html: (r) => itemCell(r.info.name, r.info.q, r.info.icon), sort: (r) => r.info.name },
    { key: "house", label: "Cheapest in", html: (r) => (r.best ? houseLabel(r.best.hid) : '<span class="muted">not listed</span>') },
    { key: "min", label: "Min buyout", num: true, html: (r) => money(r.best?.min), sort: (r) => r.best?.min },
    { key: "base", label: "Baseline", num: true, html: (r) => money(r.best?.base), sort: (r) => r.best?.base },
    { key: "target", label: "Target", num: true, html: (r) => money(r.target), sort: (r) => r.target },
    { key: "hit", label: "", html: (r) => (r.target != null && r.best && r.best.min <= r.target ? '<span class="pill t-vendor">BUY</span>' : "") },
  ], rows, { sortKey: "name", desc: false, onRow: (r) => (location.hash = itemHref(r.region, r.key)), empty: "Open an item and press Watch to add it here." }));
}

async function viewStatus(el) {
  const m = S.meta;
  const bt = m.backtest?.byType ?? {};
  el.innerHTML = `<h1 class="illumined">Status</h1>
    <div class="cards"><div class="card"><div class="k">Data generated</div><div class="v">${ago(m.generatedAt)}</div><div class="note">${new Date(m.generatedAt).toLocaleString()}</div></div>
    ${Object.entries(m.regions).map(([r, v]) => `<div class="card"><div class="k">${r.toUpperCase()}</div><div class="v">${v.items.toLocaleString()} items</div><div class="note">${v.houses.filter((h) => h.listings).length} active houses</div></div>`).join("")}
    <div class="card"><div class="k">Backtest pending</div><div class="v">${m.backtest?.pending ?? 0}</div><div class="note">trades waiting out their ${m.settings.horizonDays}-day horizon</div></div></div>
    <h2>Backtest (last 30 days)</h2>
    <p class="lead">A flagged trade counts as a hit if, during its horizon, the sell house's market value stayed at or above the relist price for at least half the hourly scans, and estimated sales covered the units. Realised ROI assumes hits earn their predicted profit and misses break even.</p>
    <div class="tablewrap"><table><thead><tr><th>Type</th><th class="num">Checked</th><th class="num">Hits</th><th class="num">Hit rate</th><th class="num">Predicted profit</th><th class="num">Realised ROI</th></tr></thead><tbody>
    ${Object.entries(bt).map(([t, b]) => `<tr><td><span class="pill t-${t}">${t}</span></td><td class="num">${b.evaluated}</td><td class="num">${b.hits}</td><td class="num">${pct(b.hitRate)}</td><td class="num">${money(b.predictedProfit)}</td><td class="num">${pct(b.realisedRoi)}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">No trades have finished their horizon yet.</td></tr>'}
    </tbody></table></div>
    <h2>Fees and thresholds</h2>
    <div class="kv card"><span class="muted">AH cut</span><span>${pct(m.fees.cutRate, 1)}</span><span class="muted">Deposit</span><span>${pct(m.fees.depositVendorRate)} of vendor price, min ${money(m.fees.depositMinCopper)}</span>
    <span class="muted">Verified</span><span>${m.fees.verified ? "yes" : "<b>no</b>"}: ${esc(m.fees.note ?? "")}</span>
    <span class="muted">Flip threshold</span><span>${pct(m.settings.flipThreshold)} of baseline</span><span class="muted">Horizon</span><span>${m.settings.horizonDays} days</span>
    <span class="muted">Minimums</span><span>${money(m.settings.minProfitCopper)} profit, ${pct(m.settings.minRoi)} ROI, ${m.settings.minSoldPerDay} sold/day</span></div>
    <h2>Houses</h2><div id="s-houses"></div>`;
  const rows = Object.entries(m.regions).flatMap(([r, v]) => v.houses.map((h) => ({ r, ...h })));
  $("#s-houses", el).replaceChildren(table([
    { key: "r", label: "Region", html: (h) => h.r.toUpperCase(), sort: (h) => h.r },
    { key: "id", label: "House", html: (h) => `<span class="fac ${h.faction}">${esc(h.name)}</span> <span class="sub">#${h.id} · ${esc(h.groupName)}</span>`, sort: (h) => h.id },
    { key: "listings", label: "Listings", num: true, html: (h) => (h.listings ?? 0).toLocaleString(), sort: (h) => h.listings },
    { key: "items", label: "Items", num: true, html: (h) => (h.items ?? 0).toLocaleString(), sort: (h) => h.items },
    { key: "scan", label: "Last scan", num: true, html: (h) => ago(h.lastScan), sort: (h) => h.lastScan },
  ], rows, { sortKey: "id", desc: false, onRow: (h) => (location.hash = `#/house/${h.r}/${h.id}`) }));
}

// ---------- search ----------
function setupSearch() {
  const input = $("#search"), list = $("#search-results");
  let sel = -1;
  const close = () => { list.hidden = true; sel = -1; };
  input.addEventListener("input", async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return close();
    const idx = await index();
    const hits = [];
    for (const it of idx.values()) {
      const n = it.name.toLowerCase();
      if (n.includes(q) || it.key === q) hits.push([n.startsWith(q) ? 0 : 1, it]);
      if (hits.length > 200) break;
    }
    hits.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    list.innerHTML = hits.slice(0, 15).map(([, it]) => `<li><a href="${itemHref(S.region, it.key)}">${itemCell(it.name, it.q, it.icon, it.cls ? esc(it.cls) : "")}</a></li>`).join("") || '<li class="muted pad">No match</li>';
    list.hidden = false;
  });
  input.addEventListener("keydown", (e) => {
    const links = [...list.querySelectorAll("a")];
    if (e.key === "ArrowDown") sel = Math.min(links.length - 1, sel + 1);
    else if (e.key === "ArrowUp") sel = Math.max(0, sel - 1);
    else if (e.key === "Enter" && links[Math.max(0, sel)]) { location.hash = links[Math.max(0, sel)].getAttribute("href"); input.value = ""; close(); return; }
    else if (e.key === "Escape") return close();
    else return;
    e.preventDefault();
    links.forEach((a, i) => a.classList.toggle("sel", i === sel));
  });
  list.addEventListener("click", () => { input.value = ""; close(); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) close(); });
}

// ---------- scope + routing ----------
function setRegion(r) {
  S.region = r;
  store.set("region", r);
  $("#region").value = r;
  fillGroups();
}
function scopeName() {
  const gs = [...new Map(houses().map((h) => [h.group, h.groupName])).entries()];
  if (gs.length === 1) return gs[0][1];
  return S.group === "all" ? "all tracked groups" : gs.find(([g]) => String(g) === String(S.group))?.[1] ?? "";
}
function fillGroups() {
  const gs = [...new Map(houses().map((h) => [h.group, h.groupName])).entries()];
  $("#group").hidden = gs.length <= 1;
  $("#realm").textContent = gs.length <= 1 ? (gs[0]?.[1] ?? "") : "";
  $("#group").innerHTML = `<option value="all">All groups</option>${gs.map(([g, n]) => `<option value="${g}">${esc(n)}</option>`).join("")}`;
  if (S.group !== "all" && !gs.some(([g]) => String(g) === String(S.group))) S.group = "all";
  $("#group").value = S.group;
}

async function route(opts = {}) {
  const y = window.scrollY;
  const el = $("#view");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === ({ "": "opps", houses: "houses", house: "houses", watch: "watch", status: "status", market: "market", trends: "trends", item: "market", crafting: "crafting", spec: "spec" })[parts[0] ?? ""]));
  chart?.destroy();
  chart = null;
  depth?.destroy();
  depth = null;
  pulseChart?.destroy();
  pulseChart = null;
  const fresh = document.createElement("div");
  el.replaceChildren(fresh);
  try {
    if (parts[0] === "item") await viewItem(fresh, parts[1], decodeURIComponent(parts[2]), parts[3] ? decodeURIComponent(parts[3]) : null);
    else if (parts[0] === "houses") await viewHouses(fresh);
    else if (parts[0] === "market") await viewMarket(fresh);
    else if (parts[0] === "trends") await viewTrends(fresh);
    else if (parts[0] === "crafting") await viewCrafting(fresh);
    else if (parts[0] === "spec") await viewSpec(fresh);
    else if (parts[0] === "house") await viewHouse(fresh, parts[1], Number(parts[2]));
    else if (parts[0] === "watch") await viewWatch(fresh);
    else if (parts[0] === "status") await viewStatus(fresh);
    else await viewOpps(fresh);
  } catch (e) {
    fresh.innerHTML = `<p class="empty">Couldn't load this page: ${esc(e.message)}</p>`;
  }
  window.scrollTo(0, opts.keepScroll ? y : 0);
}

async function fetchMeta() {
  const r = await fetch(`data/meta.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`meta.json: HTTP ${r.status}`);
  return r.json();
}

function toast(msg) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 6000);
}

/** Every 5 minutes (and when the tab regains focus), load new data if a newer snapshot exists. */
function watchForUpdates() {
  const check = async () => {
    try {
      const meta = await fetchMeta();
      if (meta.generatedAt === S.meta.generatedAt) return;
      cache.clear();
      index.maps = {};
      S.meta = meta;
      dataVersion = encodeURIComponent(meta.generatedAt);
      $("#generated").textContent = `Updated ${ago(S.meta.generatedAt)}.`;
      if (!document.activeElement?.closest?.("input, select")) await route({ keepScroll: true });
      toast(`Prices updated · Blizzard data from ${new Date(Math.max(...Object.values(meta.regions).flatMap((r) => r.houses.map((h) => h.dataTime ?? h.lastScan ?? 0)))).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } catch { /* offline: try again later */ }
  };
  setInterval(check, 5 * 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

async function main() {
  try {
    S.meta = await fetchMeta();
    dataVersion = encodeURIComponent(S.meta.generatedAt);
  } catch {
    $("#view").innerHTML = '<p class="empty">No data has been published yet. The first collection run creates it.</p>';
    return;
  }
  const regions = Object.keys(S.meta.regions);
  if (!regions.includes(S.region)) S.region = regions[0];
  $("#region").innerHTML = regions.map((r) => `<option value="${r}">${r.toUpperCase()}</option>`).join("");
  $("#region").value = S.region;
  fillGroups();
  $("#region").addEventListener("change", (e) => { setRegion(e.target.value); route(); });
  $("#group").addEventListener("change", (e) => { S.group = e.target.value; store.set("group", S.group); route(); });
  if (S.meta.demo) {
    const b = $("#banner");
    b.hidden = false;
    b.textContent = "Demo data: simulated markets, not real WoW: Forever prices. Real data appears after the first run with Blizzard API credentials.";
  }
  $("#generated").textContent = `Updated ${ago(S.meta.generatedAt)}.`;
  setupSearch();
  window.addEventListener("hashchange", route);
  route();
  watchForUpdates();
}
main();
