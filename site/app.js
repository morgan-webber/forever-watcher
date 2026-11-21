// Forever Watcher front end: a static single-page app over the JSON in ./data/.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`fw:${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`fw:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const cache = new Map();
async function load(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(`data/${path}`, { cache: "no-cache" }).then((r) => {
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
const inGroup = (id) => S.group === "all" || house(id)?.group === Number(S.group);

async function index() {
  const rows = await load(`index-${S.region}.json`);
  if (!index.maps) index.maps = {};
  if (!index.maps[S.region]) index.maps[S.region] = new Map(rows.map((r) => [r[0], { key: r[0], name: r[1], q: r[2], icon: r[3], cls: r[4], sell: r[5], variants: r[6] ?? 1 }]));
  return index.maps[S.region];
}

// ---------- sortable table ----------
function table(cols, rows, { sortKey, desc = true, onRow, empty = "Nothing here yet." } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "tablewrap";
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
      <tbody>${sorted.length ? sorted.slice(0, 1000).map((r, i) => `<tr data-i="${rows.indexOf(r)}">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.html(r, i)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length}" class="empty">${empty}</td></tr>`}</tbody></table>`;
  };
  wrap.addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (th) {
      const c = cols.find((x) => x.key === th.dataset.k);
      if (!c?.sort) return;
      if (key === c.key) dir = -dir;
      else { key = c.key; dir = -1; }
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
};

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
      <label>Type<select id="f-type"><option value="all">All</option><option value="flip">Flip</option><option value="arbitrage">Arbitrage</option><option value="vendor">Vendor</option></select></label>
      <label>Min profit (g)<input id="f-minProfit" type="number" min="0" step="1"></label>
      <label>Min ROI (%)<input id="f-minRoi" type="number" min="0" step="5"></label>
      <label>Min grade<select id="f-grade"><option>A</option><option>B</option><option>C</option><option>D</option></select></label>
      <label>Max capital (g)<input id="f-maxCost" type="number" min="0" step="10" placeholder="any"></label>
      <label>Item<input id="f-q" type="search" placeholder="filter by name"></label>
    </div>
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
      { key: "sell", label: "Sell in", html: (o) => (o.type === "vendor" ? '<span class="sub">any vendor</span>' : houseLabel(o.sell)) },
      { key: "units", label: "Units", num: true, html: (o) => o.units.toLocaleString(), sort: (o) => o.units },
      { key: "buyMax", label: "Buy ≤", num: true, title: "Highest unit price you pay", html: (o) => money(o.buyMax), sort: (o) => o.buyMax },
      { key: "sellAt", label: "Relist at", num: true, title: "Per unit", html: (o) => money(o.sellAt), sort: (o) => o.sellAt },
      { key: "cost", label: "Capital", num: true, html: (o) => money(o.cost), sort: (o) => o.cost },
      { key: "ev", label: "Exp. profit", num: true, html: (o) => `<b>${money(o.ev)}</b>`, sort: (o) => o.ev },
      { key: "roi", label: "ROI", num: true, html: (o) => pct(o.roi), sort: (o) => o.roi },
      { key: "days", label: "Days", num: true, title: "Estimated days to sell the units", html: (o) => (o.type === "vendor" ? "0" : fixed(o.days)), sort: (o) => o.days },
      { key: "grade", label: "Grade", html: (o) => `<span class="grade ${o.grade}" title="A: lots of history, steady price and sales · D: thin data">${o.grade}</span>`, sort: (o) => grades.indexOf(o.grade) },
    ], rows, { sortKey: "ev", onRow: (o) => (location.hash = itemHref(S.region, o.key)), empty: opps.length ? "No opportunities match these filters." : "No opportunities yet. Flips and arbitrage need about a day of price and sales history." });
    $("#opps-table", el).replaceChildren(t);
  };
  el.addEventListener("input", (e) => { if (e.target.closest(".filters")) draw(); });
  draw();
}

let chart = null;
async function viewItem(el, region, base, variantKey) {
  if (region !== S.region) setRegion(region);
  const idx = await index();
  const info = idx.get(base) ?? { name: `Item ${base}`, q: "COMMON" };
  let file;
  try { file = await load(`items/${region}/${base}.json`); } catch { el.innerHTML = `<p class="empty">No market data for item ${esc(base)} in ${region.toUpperCase()} yet.</p>`; return; }
  const vkeys = Object.keys(file.variants).sort((a, b) => (a === base ? -1 : b === base ? 1 : Object.keys(file.variants[b]).length - Object.keys(file.variants[a]).length || a.localeCompare(b)));
  const listedCount = (k) => Object.values(file.variants[k]).filter((v) => v.m?.listed).reduce((n, v) => n + (v.h.at(-1)?.[3] ?? 0), 0);
  let vkey = variantKey && file.variants[variantKey] ? variantKey : vkeys.slice().sort((a, b) => listedCount(b) - listedCount(a))[0];
  const data = { houses: file.variants[vkey] };
  const hs = Object.entries(data.houses).map(([hid, v]) => ({ hid: Number(hid), ...v, last: v.h.at(-1) })).filter((x) => house(x.hid));
  const watched = S.watch.find((w) => w.region === region && w.key === vkey);
  el.innerHTML = `
    <div class="itemhead"><span class="icon lg" style="background-image:url('${iconUrl(info.icon)}')"></span>
      <div><h1 class="q-${esc(info.q)}">${esc(info.name)}</h1><div class="meta">${esc(info.cls ?? "Item")} · #${esc(base)}${info.sell != null ? ` · vendors for ${money(info.sell)}` : ""} · ${region.toUpperCase()}</div></div>
      <div class="watchbox">
        <label>Alert under (gold)<input id="w-target" type="number" min="0" step="0.01" style="width:120px" value="${watched?.target != null ? watched.target / 10000 : ""}"></label>
        <button class="${watched ? "ghost" : "primary"}" id="w-btn">${watched ? "Stop watching" : "Watch"}</button>
      </div>
    </div>
    ${vkeys.length > 1 ? `<div class="variant-bar"><label class="note" for="v-sel">Variant (random suffixes are priced separately)</label><select id="v-sel">${vkeys.map((k) => `<option value="${esc(k)}" ${k === vkey ? "selected" : ""}>${k === base ? "Plain" : `Bonus ${esc(bonusOf(k))}`} · ${listedCount(k).toLocaleString()} listed</option>`).join("")}</select></div>` : ""}
    <div class="chartbox">
      <div class="chartbar"><select id="c-house" aria-label="House"></select><div class="tabs" id="c-range"><button data-r="h">Hourly · ${S.meta.settings.hourlyKeepHours / 24} days</button><button data-r="30">30 days</button><button data-r="365">A year</button></div><span class="note" id="c-note"></span></div>
      <div id="chart"></div>
    </div>
    <h2>Across houses</h2><div id="item-houses"></div>
    <p class="note">Baseline is the mean daily market value over ${S.meta.settings.baselineDays} days. Sold per day and sell-through are estimated from auctions that vanish between scans, so sell-through errs low.</p>`;
  $("#v-sel", el)?.addEventListener("change", (e) => (location.hash = itemHref(region, e.target.value)));

  const rows = hs.sort((a, b) => (b.m?.soldPerDay ?? 0) - (a.m?.soldPerDay ?? 0));
  const sel = $("#c-house", el);
  $("#item-houses", el).replaceChildren(table([
    { key: "house", label: "House", html: (x) => houseLabel(x.hid), sort: (x) => x.hid },
    { key: "min", label: "Lowest", num: true, html: (x) => (x.m?.listed ? money(x.last[2]) : '<span class="muted">not listed</span>'), sort: (x) => (x.m?.listed ? x.last[2] : null) },
    { key: "mv", label: "Market value", num: true, html: (x) => (x.m?.listed ? money(x.last[1]) : "–"), sort: (x) => (x.m?.listed ? x.last[1] : null) },
    { key: "base", label: "Baseline", num: true, html: (x) => money(x.m?.baseline), sort: (x) => x.m?.baseline },
    { key: "qty", label: "Listed", num: true, html: (x) => (x.m?.listed ? x.last[3].toLocaleString() : "0"), sort: (x) => (x.m?.listed ? x.last[3] : 0) },
    { key: "spd", label: "Sold a day", num: true, html: (x) => fixed(x.m?.soldPerDay), sort: (x) => x.m?.soldPerDay },
    { key: "st", label: "Sell-through", num: true, html: (x) => pct(x.m?.sellThrough), sort: (x) => x.m?.sellThrough },
    { key: "chg", label: "24 hours", num: true, html: (x) => signed(x.m?.chg24), sort: (x) => x.m?.chg24 },
  ], rows, { sortKey: "spd", onRow: (x) => { sel.value = x.hid; draw(); } }));

  sel.innerHTML = rows.map((x) => `<option value="${x.hid}">${esc(house(x.hid).name)} · ${esc(house(x.hid).groupName)}</option>`).join("");
  const pref = rows.find((x) => inGroup(x.hid) && x.m?.listed) ?? rows[0];
  if (pref) sel.value = pref.hid;
  let range = store.get("range", "h");
  const draw = () => {
    for (const b of el.querySelectorAll("#c-range button")) b.classList.toggle("on", b.dataset.r === range);
    const x = data.houses[sel.value];
    const box = $("#chart", el);
    chart?.destroy();
    chart = null;
    if (!x) { box.innerHTML = '<p class="empty">No history in this house yet.</p>'; return; }
    let t, mv, mn, sold = null;
    if (range === "h") {
      t = x.h.map((p) => p[0] * 3600); mv = x.h.map((p) => p[1] / 10000); mn = x.h.map((p) => p[2] / 10000);
    } else {
      const minDay = Math.floor(Date.now() / 86400000) - Number(range);
      const d = x.d.filter((r) => r[0] >= minDay);
      t = d.map((r) => r[0] * 86400); mv = d.map((r) => (r[1] == null ? null : r[1] / 10000)); mn = d.map((r) => (r[2] == null ? null : r[2] / 10000)); sold = d.map((r) => r[4]);
    }
    $("#c-note", el).textContent = t.length < 2 ? "Not enough history for this range yet: the chart fills in hour by hour." : "";
    const axis = { stroke: "#b9aa8c", font: "14px Alegreya, Georgia, serif", grid: { stroke: "rgba(227,184,92,.10)" }, ticks: { stroke: "rgba(227,184,92,.25)" } };
    const fmt = (u, v) => (v == null ? "–" : money(v * 10000, { plain: true }));
    const series = [{}, { label: "Market value", stroke: "#e3b85c", width: 2.5, fill: "rgba(227,184,92,.08)", points: { show: false }, value: fmt },
      { label: "Lowest listing", stroke: "#58a79c", width: 1.5, dash: [5, 4], points: { show: false }, value: fmt }];
    const dataArr = [t, mv, mn];
    const axes = [axis, { ...axis, values: (u, vals) => vals.map((v) => `${+v.toFixed(4)}g`), size: 70 }];
    if (sold) {
      series.push({ label: "Estimated sold", stroke: "#8fd49a", width: 1, scale: "n", paths: uPlot.paths.bars({ size: [0.55, 26] }), fill: "rgba(143,212,154,.25)" });
      dataArr.push(sold);
      axes.push({ ...axis, scale: "n", side: 1, grid: { show: false }, size: 46 });
    }
    chart = new uPlot({ width: Math.max(300, box.clientWidth || el.clientWidth - 40), height: 320, series, axes, scales: { x: { time: true } }, legend: { live: true }, cursor: { drag: { x: true, y: false } } }, dataArr, box);
  };
  sel.addEventListener("change", draw);
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
        <div class="note">${t.listings ? `${t.listings.toLocaleString()} listings, ${t.items.toLocaleString()} items tracked` : "empty"} · scanned ${ago(t.lastScan)}</div></a>`
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

async function route() {
  const el = $("#view");
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === ({ "": "opps", houses: "houses", house: "houses", watch: "watch", status: "status" })[parts[0] ?? ""]));
  chart?.destroy();
  chart = null;
  const fresh = document.createElement("div");
  el.replaceChildren(fresh);
  try {
    if (parts[0] === "item") await viewItem(fresh, parts[1], decodeURIComponent(parts[2]), parts[3] ? decodeURIComponent(parts[3]) : null);
    else if (parts[0] === "houses") await viewHouses(fresh);
    else if (parts[0] === "house") await viewHouse(fresh, parts[1], Number(parts[2]));
    else if (parts[0] === "watch") await viewWatch(fresh);
    else if (parts[0] === "status") await viewStatus(fresh);
    else await viewOpps(fresh);
  } catch (e) {
    fresh.innerHTML = `<p class="empty">Couldn't load this page: ${esc(e.message)}</p>`;
  }
  window.scrollTo(0, 0);
}

async function main() {
  try {
    S.meta = await load("meta.json");
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
}
main();
