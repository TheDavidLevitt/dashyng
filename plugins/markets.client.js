// Markets widget — CLIENT (loaded verbatim by plugins/markets.js, executed in the page's
// GLOBAL scope by the plugin loader). Page function-declarations (toast, rpcPoll,
// makeSwipeable, withTaskHistory…) are reachable; script-scoped consts are not, so the
// few we need are re-declared locally. The original 381-line markets code is UNCHANGED
// below the shims — template literals and all (that is why this lives in its own file
// instead of an escaped string).
(el, data) => {
  const $ = id => document.getElementById(id);
  const { api, esc, toast, rpcPoll } = window.dashyng || {};
  if (!document.getElementById('markets-css')) {
    const st = document.createElement('style'); st.id = 'markets-css';
    st.textContent = "/* markets \u2014 30-col grid so tile sizes divide cleanly: ticker=3 (10/row), small=5 (6/row), large=15 (2/row) */\n.market-grid { display: grid; grid-template-columns: repeat(30, 1fr); gap: 6px; }\n.m-tile { background: var(--card2); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px;\n  position: relative; overflow: hidden; grid-column: span 5; }\n/* ticker = half a small card: half the grid width, tighter padding, smaller type */\n.m-tile.sz-ticker { grid-column: span 3; padding: 2px 5px; }\n.m-tile.sz-ticker .m-value { font-size: 11px; }\n.m-tile.sz-ticker .m-label { font-size: 8px; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.m-tile.sz-ticker .m-change { font-size: 9px; }\n.m-tile.sz-small { grid-column: span 5; }\n.m-tile.sz-large { grid-column: span 15; min-height: 130px; }\n.m-tile.dragover { outline: 2px dashed var(--accent); outline-offset: -2px; }\n.m-tile .m-tools { position: absolute; top: 1px; right: 1px; display: none; gap: 1px; z-index: 3; } /* .m-tile .m-tools beats the `.m-tile > *` position:relative rule */\n.m-tile:hover .m-tools { display: flex; }\n@media (hover: none) { .m-tile .m-tools { display: flex; opacity: 0.85; } } /* touch: hover never fires \u2014 keep tile tools reachable */\n.m-tools button { background: var(--card); color: var(--text2); border: 1px solid var(--border); border-radius: 3px;\n  font-size: 9px; padding: 0 4px; cursor: pointer; line-height: 14px; }\n.m-tools button:hover { color: var(--accent); border-color: var(--accent); }\n.m-add-tile { display: flex; align-items: center; justify-content: center; color: var(--text3); cursor: pointer;\n  border-style: dashed; font-size: 18px; min-height: 44px; }\n.m-add-tile:hover { color: var(--accent); border-color: var(--accent); }\n#mkt-form { background: var(--card2); border: 1px solid var(--border); border-radius: 6px; padding: 9px 11px; margin: 6px 0; }\n#mkt-form input, #mkt-form select { background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; font-size: 12px; }\n#mkt-form label { font-size: 11.5px; color: var(--text2); margin-right: 10px; }\n/* the \uff0b Add menu: one dropdown of categories, each opening a second-level list to the right */\n.mk-menu { position: relative; display: inline-block; }\n.mk-btn { background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 4px;\n  padding: 3px 10px; font-size: 12px; cursor: pointer; }\n.mk-btn:hover { color: var(--accent); border-color: var(--accent); }\n.mk-mi { font-size: 12px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }\n.mk-mi:hover { background: var(--card); color: var(--accent); }\n.mk-mi .mk-arrow { color: var(--text3); float: right; margin-left: 10px; }\n.mk-list { display: none; position: absolute; z-index: 30; background: var(--card2);\n  border: 1px solid var(--border); border-radius: 6px; min-width: 160px; max-height: 260px; overflow-y: auto;\n  box-shadow: 0 6px 18px rgba(0,0,0,0.4); }\n.mk-root { left: 0; top: 100%; overflow: visible; max-height: none; } /* categories never scroll; sub-lists do */\n.mk-menu:hover > .mk-root, .mk-menu.open > .mk-root { display: block; }\n.mk-mi.mk-sub { position: relative; }\n.mk-sub-list { left: 100%; top: -4px; }\n.mk-sub:hover > .mk-sub-list, .mk-sub.open > .mk-sub-list { display: block; }\n.mk-more-row { padding: 3px 0; display: flex; gap: 4px; }\n.mk-more-row input { width: 110px; }\n.mk-more-row button { font-size: 11px; cursor: pointer; }\n@media (max-width: 700px) { .mk-sub-list { left: 40px; top: 100%; } } /* narrow screens: open below, indented */\n@media (max-width: 700px) {\n  .m-tile.sz-ticker { grid-column: span 6; }\n  .m-tile.sz-small { grid-column: span 10; }\n  .m-tile.sz-large { grid-column: span 30; }\n}\n.m-tile > * { position: relative; }\n.m-label { font-size: 9.5px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.04em; }\n.m-value { font-size: 14.5px; font-weight: 650; font-variant-numeric: tabular-nums; }\n.m-change { font-size: 11px; font-variant-numeric: tabular-nums; }\n.m-held { float: right; color: var(--text2); font-weight: 400; margin-top: 3px; } /* holdings $ value, right of the price */\n.m-change.up { color: var(--green); } .m-change.down { color: var(--red); } .m-change.flat { color: var(--text2); }\n.m-spark { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }\n.m-axis { position: absolute; left: 2px; font-size: 7px; color: var(--text3); opacity: 0.7; pointer-events: none; font-variant-numeric: tabular-nums; }\n.m-axis-top { top: 2px; } .m-axis-bot { bottom: 2px; }\n.m-axis-x { bottom: 2px; right: 4px; left: auto; }";
    document.head.appendChild(st);
  }
  el.innerHTML = "<div style=\"margin:2px 0 4px;font-size:12px;color:var(--text2)\"><button id=\"mkt-add-btn\" onclick=\"mktFormToggle()\" title=\"add a tile\" style=\"background:var(--card);color:var(--accent);border:1px solid var(--border);border-radius:4px;font-size:11px;line-height:15px;padding:0 6px;cursor:pointer\">\uff0b</button> <span class=\"muted\" id=\"mkt-ts\"></span> <span class=\"tiny\" style=\"font-weight:400\">\u2014 drag to reorder \u00b7 \u2924 resize</span></div>\n<div class=\"card\">\n  <div id=\"mkt-form\" style=\"display:none\"></div>\n  <div class=\"market-grid\" id=\"markets\"><div class=\"empty\">Loading\u2026</div></div>\n</div>\n";

function sparkSvg(values, up, rangeLabel) {
  if (!values || values.length < 2) return '';
  const W = 100, H = 40, P = 3;
  const min = Math.min(...values), max = Math.max(...values), range = (max - min) || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1) * W).toFixed(1)},${(H - P - (v - min) / range * (H - 2 * P)).toFixed(1)}`);
  const color = up ? 'var(--green)' : 'var(--red)';
  // very small y-axis labels (max top-left, min bottom-left) on every tile
  const lbl = n => n >= 1000 ? Math.round(n).toLocaleString() : n >= 100 ? Math.round(n) : n >= 1 ? n.toFixed(1) : n.toFixed(3);
  return `<svg class="m-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0,${H} L${pts.join(' L')} L${W},${H} Z" fill="${color}" opacity="0.08"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.2" opacity="0.4"/></svg>
    <span class="m-axis m-axis-top">${lbl(max)}</span><span class="m-axis m-axis-bot">${lbl(min)}</span><span class="m-axis m-axis-x">${esc(rangeLabel || '1y')}</span>`;
}
// stocks → 2 significant figures (whole $ unless <10); 4-digit indices → full; fx keeps precision
function sig2(n) {
  if (n == null) return '—';
  if (n >= 1000) return Math.round(n).toLocaleString('en-US');
  if (n >= 10) return String(Math.round(n));
  return n.toFixed(1);
}
// compact money: 1.24M / 30.9k / 254.20 — for holdings values and portfolio totals
function fmtMoney(n) {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2);
}
function fmtPrice(q) {
  if (q.price == null) return '—';
  if (q.fmt === 'int') return Math.round(q.price).toLocaleString('en-US');
  if (q.fmt === 'fx') return q.price.toFixed(q.price >= 10 ? 2 : 4);
  if (q.fmt === 'num') return sig2(q.price);
  if (q.fmt === 'eur') return q.priceUsd ? `€${sig2(q.price)}/$${sig2(q.priceUsd)}` : '€' + sig2(q.price);
  if (q.fmt === 'stock' || q.fmt === 'usd') return '$' + sig2(q.price);
  return sig2(q.price);
}
// ---- configurable market tiles: sizes (ticker/small/large), drag-reorder, add/remove ----
const MKT_SIZES = ['ticker', 'small', 'large'];
const MKT_RANGES = ['max', '5y', '1y', '1mo', '1wk'];
// The "＋ Add" menu: five categories, each a hover/tap submenu. Clicking an item STAGES it
// (nothing is added yet) — the staging row offers futures-strip / range / #shares / free-text
// tweaks, then Add commits. strip:'key' marks items that have a liquid futures curve.
const mkQ = (sym, label, fmt, strip, size) => ({ label, strip, tile: { type: 'quote', sym, label, fmt: fmt || 'stock', range: '1y', size: size || 'small' } });
const MKT_COMPANIES = [ // biggest 20 by market cap
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'],
  ['2222.SR', 'Saudi Aramco'], ['META', 'Meta'], ['AVGO', 'Broadcom'], ['TSM', 'TSMC'], ['BRK-B', 'Berkshire'],
  ['LLY', 'Eli Lilly'], ['TSLA', 'Tesla'], ['V', 'Visa'], ['WMT', 'Walmart'], ['JPM', 'JPMorgan'],
  ['NVO', 'Novo Nordisk'], ['MA', 'Mastercard'], ['XOM', 'Exxon Mobil'], ['UNH', 'UnitedHealth'], ['ORCL', 'Oracle'],
];
const MKT_REITS = [ // major REITs
  ['PLD', 'Prologis'], ['AMT', 'American Tower'], ['EQIX', 'Equinix'], ['DLR', 'Digital Realty'],
  ['SPG', 'Simon Property'], ['PSA', 'Public Storage'], ['O', 'Realty Income'], ['WELL', 'Welltower'], ['STWD', 'Starwood Property'],
];
const MKT_CDS_TOP = ['United States', 'China', 'Japan', 'Germany', 'India', 'United Kingdom', 'France', 'Italy', 'Brazil', 'Canada'];
const MKT_MENU = {
  'Indices': [
    mkQ('^GSPC', 'S&P 500', 'int', 'sp'), mkQ('^IXIC', 'Nasdaq', 'int', 'nasdaq'), mkQ('^DJI', 'Dow', 'int', 'dow'),
    mkQ('^VIX', 'VIX', 'num'), mkQ('^FTSE', 'FTSE 100', 'int'), mkQ('^GDAXI', 'DAX', 'int'), mkQ('^N225', 'Nikkei 225', 'int'),
  ],
  'Stocks': MKT_COMPANIES.map(([sym, l]) => ({ label: l, note: sym, tile: { type: 'quote', sym, label: l, fmt: 'stock', range: '1y', size: 'ticker' } })),
  'REITs': MKT_REITS.map(([sym, l]) => ({ label: l, note: sym, tile: { type: 'quote', sym, label: l, fmt: 'stock', range: '1y', size: 'small' } })),
  'Commodities': [
    mkQ('BZ=F', 'Brent', 'num', 'oil'), mkQ('CL=F', 'WTI (futures to ~12y)', 'num', 'wti'), mkQ('NG=F', 'Henry Hub gas', 'num', 'gas'),
    mkQ('GC=F', 'Gold', 'int', 'gold'), mkQ('BTC-USD', 'Bitcoin', 'int', 'btc'),
    mkQ('XLU', 'US Electricity (Utilities proxy)'), mkQ('UTIL.L', 'EU Electricity (Utilities proxy)'),
  ],
  'FX': [
    mkQ('EURUSD=X', 'EUR/USD', 'fx'), mkQ('GBPUSD=X', 'GBP/USD', 'fx'), mkQ('USDJPY=X', 'USD/JPY', 'fx'),
    mkQ('CHFUSD=X', 'CHF/USD', 'fx'), mkQ('USDCNY=X', 'USD/CNY', 'fx'), mkQ('DX-Y.NYB', 'Dollar index (DXY)', 'num'),
  ],
  'Treasuries & CDS': [
    { label: 'UST yield curve', tile: { type: 'ustcurve', size: 'small' } },
    { label: 'SOFR forward curve', tile: { type: 'strip', preset: 'sofr', size: 'small' } },
    ...MKT_CDS_TOP.map(c => ({ label: c + ' CDS', tile: { type: 'cds', country: c, size: 'small' } })),
    { label: 'More…', cdsMore: true },
  ],
};
let mktData = null;
function mktCfg(body) { return api('/api/markets/config', { method: 'POST', body: JSON.stringify(body) }).then(() => loadMarkets()); }
function loadMarkets() { return api('/api/markets').then(d => { mktData = d; renderMarkets(d); }).catch(() => { $('markets').innerHTML = '<div class="err">Market data unavailable</div>'; }); }
// multi-series term-structure chart on ONE shared time axis (x = months ahead): curves with
// shorter listings simply end early. Axes are assigned by CATEGORY (oil left, gas right —
// Brent+WTI share the left $/bbl axis), max 2 categories per plot (enforced server-side).
// Solid = today; dashed = prior day; dotted = prior month. A small "}" + pct beside the
// front month flags a significant (≥1.5%) day move.
const STRIP_COLORS = ['var(--green)', 'var(--red)', 'var(--violet)', 'var(--amber)'];
function tileStripSvg(series, big, opts) {
  series = (series || []).filter(s => (s.pts || []).length >= 2);
  if (!series.length) return '<div class="m-change flat">strip unavailable</div>';
  const showY = (opts || {}).showYday !== false, showM = !!(opts || {}).showMonthAgo;
  const W = 220, H = big ? 100 : 46, PL = 20, PR = series.length > 1 ? 20 : 8, PT = 9, PB = big ? 12 : 4;
  const fmtV = (v, s) => s.invert ? v.toFixed(2) + '%' : (v >= 10000 ? Math.round(v / 1000) + 'k' : v >= 100 ? v.toFixed(0) : v.toFixed(2));
  const cats = [...new Set(series.map(s => s.cat || s.key || s.label))];
  const axisOf = si => cats.length > 1 && (series[si].cat || series[si].key || series[si].label) === cats[1] ? 1 : 0; // first category = left axis
  const hasM = series.every(s => s.pts.every(p => p.m != null));
  const maxM = hasM ? Math.max(...series.flatMap(s => s.pts.map(p => p.m)), 1) : 0;
  const axVals = [[], []];
  series.forEach((s, i) => s.pts.forEach(p => { for (const k of ['today', showY && 'yday', showM && 'monthAgo']) if (k && p[k] != null) axVals[axisOf(i)].push(p[k]); }));
  const rng = axVals.map(v => v.length ? [Math.min(...v), Math.max(...v)] : [0, 1]);
  const xs = (p, i, n) => PL + (hasM ? p.m / maxM : i / Math.max(1, n - 1)) * (W - PL - PR);
  const ys = (v, ax) => H - PB - (v - rng[ax][0]) / ((rng[ax][1] - rng[ax][0]) || 1) * (H - PT - PB);
  let svg = '';
  series.forEach((s, si) => {
    const ax = axisOf(si), color = STRIP_COLORS[si % STRIP_COLORS.length], n = s.pts.length;
    const line = key => s.pts.map((p, i) => p[key] != null ? `${xs(p, i, n).toFixed(1)},${ys(p[key], ax).toFixed(1)}` : null).filter(Boolean).join(' ');
    if (showM) svg += `<polyline points="${line('monthAgo')}" fill="none" stroke="${color}" stroke-width="0.9" stroke-dasharray="1 2.5" opacity="0.55"/>`;
    if (showY) svg += `<polyline points="${line('yday')}" fill="none" stroke="${color}" stroke-width="0.9" stroke-dasharray="3 2" opacity="0.6"/>`;
    svg += `<polyline points="${line('today')}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
    const f = s.pts.find(p => p.today != null && p.yday != null);
    if (f && Math.abs(f.today - f.yday) / Math.abs(f.yday || 1) >= 0.015) {
      const ym = (ys(f.yday, ax) + ys(f.today, ax)) / 2 + 2, pct = (f.today - f.yday) / f.yday * 100;
      svg += `<text x="${(PL + 1).toFixed(1)}" y="${ym.toFixed(1)}" font-size="7" fill="${color}">}</text><text x="${(PL + 6).toFixed(1)}" y="${ym.toFixed(1)}" font-size="5.5" font-weight="700" fill="${color}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</text>`;
    }
    const axX = ax === 1 ? W - PR + 2 : 1;
    svg += `<text x="${axX}" y="${PT + 1}" font-size="6.5" fill="${color}">${fmtV(rng[ax][1], s)}</text><text x="${axX}" y="${H - PB}" font-size="6.5" fill="${color}">${fmtV(rng[ax][0], s)}</text>`;
  });
  // x labels along the true time axis, from the series reaching furthest out
  const longest = hasM ? series.reduce((a, s) => s.pts[s.pts.length - 1].m > a.pts[a.pts.length - 1].m ? s : a, series[0])
    : series.reduce((a, s) => s.pts.length > a.pts.length ? s : a, series[0]);
  const step = Math.max(1, Math.ceil(longest.pts.length / 10));
  const xlab = big ? longest.pts.map((p, i) => i % step === 0 ? `<text x="${xs(p, i, longest.pts.length).toFixed(1)}" y="${H - 2}" font-size="5" fill="var(--text3)" text-anchor="middle">${esc(p.label)}</text>` : '').join('') : '';
  const legend = big && series.length > 1 ? series.map((s, i) => `<text x="${PL + 4 + i * 66}" y="6" font-size="5.5" fill="${STRIP_COLORS[i % STRIP_COLORS.length]}">${esc(s.label.split(' (')[0])}</text>`).join('') : '';
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${svg}${xlab}${legend}</svg>`;
}
// grouped multi-series time plot (drag a tile onto a large plot): one real time axis,
// per-category left/right value axes, series with shorter history just start later.
function tileGroupSvg(series, big) {
  series = (series || []).filter(s => (s.pts || []).length >= 2);
  if (!series.length) return '<div class="m-change flat">no plottable series</div>';
  const W = 220, H = big ? 100 : 46, PL = 22, PR = 22, PT = 9, PB = big ? 12 : 4;
  const cats = [...new Set(series.map(s => s.cat))];
  const axisOf = s => cats.length > 1 && s.cat === cats[1] ? 1 : 0;
  const tMin = Math.min(...series.flatMap(s => s.pts.map(p => p.t)));
  const tMax = Math.max(...series.flatMap(s => s.pts.map(p => p.t)));
  const axVals = [[], []];
  series.forEach(s => s.pts.forEach(p => axVals[axisOf(s)].push(p.v)));
  const rng = axVals.map(v => v.length ? [Math.min(...v), Math.max(...v)] : [0, 1]);
  const xs = t => PL + (t - tMin) / ((tMax - tMin) || 1) * (W - PL - PR);
  const ys = (v, ax) => H - PB - (v - rng[ax][0]) / ((rng[ax][1] - rng[ax][0]) || 1) * (H - PT - PB);
  const fmtV = v => v >= 10000 ? Math.round(v / 1000) + 'k' : v >= 100 ? v.toFixed(0) : v.toFixed(2);
  let svg = '';
  series.forEach((s, si) => {
    const ax = axisOf(s), color = STRIP_COLORS[si % STRIP_COLORS.length];
    svg += `<polyline points="${s.pts.map(p => `${xs(p.t).toFixed(1)},${ys(p.v, ax).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.3"/>`;
  });
  [0, 1].forEach(ax => {
    if (!axVals[ax].length) return;
    const s0 = series.find(s => axisOf(s) === ax), color = STRIP_COLORS[series.indexOf(s0) % STRIP_COLORS.length];
    const axX = ax === 1 ? W - PR + 2 : 1;
    svg += `<text x="${axX}" y="${PT + 1}" font-size="6.5" fill="${color}">${fmtV(rng[ax][1])}</text><text x="${axX}" y="${H - PB}" font-size="6.5" fill="${color}">${fmtV(rng[ax][0])}</text>`;
  });
  const dateLab = t => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  const xlab = big ? [tMin, (tMin + tMax) / 2, tMax].map(t => `<text x="${xs(t).toFixed(1)}" y="${H - 2}" font-size="5" fill="var(--text3)" text-anchor="middle">${dateLab(t)}</text>`).join('') : '';
  const legend = big ? series.map((s, i) => `<text x="${PL + 4 + i * 60}" y="6" font-size="5.5" fill="${STRIP_COLORS[i % STRIP_COLORS.length]}">${esc(String(s.label).split(' (')[0].slice(0, 14))}</text>`).join('') : '';
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${svg}${xlab}${legend}</svg>`;
}
function tileCurveSvg(c, big) {
  if (!c || c.error || !(c.curve || []).length) return '<div class="m-change flat">curve unavailable</div>';
  const pts = c.curve, prev = c.prevCurve || [];
  const W = 200, H = big ? 90 : 44, P = 6, PB = big ? 12 : 4;
  const vals = pts.map(p => p.yield).concat(prev.map(p => p.yield)).filter(v => v != null);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const xs = i => P + i / Math.max(1, pts.length - 1) * (W - 2 * P);
  const ys = v => H - PB - (v - mn) / ((mx - mn) || 1) * (H - P - PB);
  const line = arr => arr.map((p, i) => `${xs(i).toFixed(1)},${ys(p.yield).toFixed(1)}`).join(' ');
  const xlab = big ? pts.map((p, i) => i % 2 === 0 ? `<text x="${xs(i).toFixed(1)}" y="${H - 2}" font-size="5.5" fill="var(--text3)" text-anchor="middle">${esc(p.tenor)}</text>` : '').join('') : '';
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    ${prev.length ? `<polyline points="${line(prev)}" fill="none" stroke="var(--text3)" stroke-width="1" stroke-dasharray="2 2" opacity="0.6"/>` : ''}
    <polyline points="${line(pts)}" fill="none" stroke="var(--amber)" stroke-width="1.5"/>
    <text x="${P}" y="8" font-size="7" fill="var(--text3)">${mx.toFixed(1)}%</text><text x="${P}" y="${H - PB - 2}" font-size="7" fill="var(--text3)">${mn.toFixed(1)}%</text>${xlab}</svg>`;
}
function renderMarkets(data) {
  $('mkt-ts').textContent = '— live, ' + new Date(data.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    + (data.configError ? ' · ⚠ showing defaults, your saved layout failed to load' : '');
  const tools = q => `<div class="m-tools">
    ${q.type === 'strip' ? `<button title="edit curves (comma list: oil,wti,gas,gold,btc,sp,nasdaq,dow,sofr)" onclick="mktStripSeries('${esc(q.id)}')">≡</button><button title="toggle prior-day strip" style="${q.showYday !== false ? 'color:var(--accent)' : ''}" onclick="mktStripToggle('${esc(q.id)}','showYday')">d</button><button title="toggle prior-month strip" style="${q.showMonthAgo ? 'color:var(--accent)' : ''}" onclick="mktStripToggle('${esc(q.id)}','showMonthAgo')">m</button>` : ''}
    ${['quote', 'group'].includes(q.type) && q.size !== 'ticker' ? `<button title="cycle x-range (now ${esc(q.range || '1y')})" onclick="mktRange('${esc(q.id)}')">${esc(q.range || '1y')}</button>` : ''}
    ${q.type === 'portfolio' ? '' : `<button title="resize" onclick="mktResize('${esc(q.id)}')">⤢</button><button title="remove" onclick="mktRemove('${esc(q.id)}')">✕</button>`}</div>`;
  const tile = q => {
    const sz = q.size || 'small';
    const body = (() => {
      if (q.error) return `<div class="m-label">${esc(q.label)}</div><div class="m-change flat">unavailable</div>`;
      if (q.type === 'strip') {
        const front = q.series && q.series[0] && q.series[0].pts && q.series[0].pts[0];
        return `<div class="m-label">${esc(q.label || q.stripLabel)}</div>${sz === 'ticker'
          ? `<div class="m-value">${front && front.today != null ? (front.today >= 100 ? Math.round(front.today).toLocaleString() : front.today.toFixed(2)) : '—'}</div>`
          : tileStripSvg(q.series, sz === 'large', q)}`;
      }
      if (q.type === 'ustcurve') return `<div class="m-label">${esc(q.label)}${q.curve && q.curve.spread2s10s != null ? ` <span class="tiny">2s10s ${q.curve.spread2s10s}bp</span>` : ''}</div>${sz === 'ticker' ? `<div class="m-value">${q.curve?.curve?.find(p => p.tenor === '10Y')?.yield?.toFixed(2) ?? '—'}% 10Y</div>` : tileCurveSvg(q.curve, sz === 'large')}`;
      if (q.type === 'cds') {
        const c = q.cds || {};
        if (c.error || c.cds5y == null) return `<div class="m-label">${esc(q.label)}</div><div class="m-change flat">${esc(c.error || 'unavailable')}</div>`;
        const up = c.var1m >= 0; // CDS up = risk up = red
        return `${sz === 'ticker' ? '' : (c.spark && c.spark.length > 1 ? sparkSvg(c.spark, !up, c.sparkSpan || '1y') : '')}
          <div class="m-label">${esc(c.country)} CDS <span class="tiny">${esc(c.rating || '')}</span></div>
          <div class="m-value">${c.cds5y.toFixed(0)} <span class="tiny" style="font-weight:400">bp</span></div>
          ${sz === 'ticker' ? '' : `<div class="m-change ${up ? 'down' : 'up'}">${up ? '+' : ''}${c.var1m.toFixed(1)}% 1m</div>`}`;
      }
      if (q.type === 'group') {
        return `<div class="m-label">${esc(q.label)}</div>${sz === 'ticker'
          ? `<div class="m-value">${q.series && q.series[0] && q.series[0].last != null ? fmtMoney(q.series[0].last) : '—'}</div>`
          : tileGroupSvg(q.series, sz === 'large')}`;
      }
      if (q.type === 'portfolio') {
        return `<div class="m-label">Portfolio</div><div class="m-value">$${fmtMoney(q.total)}</div>
          ${(q.items || []).map(i => `<div class="tiny" style="display:flex;justify-content:space-between"><span>${esc(i.label)}</span><span>$${fmtMoney(i.value)}</span></div>`).join('')}`;
      }
      const up = (q.changePct ?? 0) >= 0;
      const chg = q.changePct == null ? '' : `<div class="m-change ${up ? 'up' : 'down'}">${up ? '+' : ''}${q.changePct.toFixed(2)}%</div>`;
      const held = q.shares > 0 && q.price != null
        ? `<span class="m-held tiny">${q.shares} sh · $${fmtMoney((q.priceUsd ?? q.price) * q.shares)}</span>` : '';
      return `${sz === 'ticker' ? '' : sparkSvg(q.spark, up, q.range || '1y')}
        <div class="m-label"><a href="https://finance.yahoo.com/quote/${encodeURIComponent(q.sym)}" target="_blank" rel="noopener">${esc(q.label)}</a></div>
        <div class="m-value">${fmtPrice(q)}${held}</div>${chg}`;
    })();
    return `<div class="m-tile sz-${sz}" draggable="${q.type !== 'portfolio'}" data-mid="${esc(q.id)}">${tools(q)}${body}</div>`;
  };
  $('markets').innerHTML = data.quotes.filter(q => q.type !== 'meta').map(tile).join('');
  wireMktDrag();
}
function mktResize(id) { const t = (mktData?.quotes || []).find(x => x.id === id); if (!t) return; const next = MKT_SIZES[(MKT_SIZES.indexOf(t.size || 'small') + 1) % MKT_SIZES.length]; mktCfg({ action: 'update', id, size: next }); }
function mktRange(id) { const t = (mktData?.quotes || []).find(x => x.id === id); if (!t) return; const next = MKT_RANGES[(MKT_RANGES.indexOf(t.range || '1y') + 1) % MKT_RANGES.length]; mktCfg({ action: 'update', id, range: next }); }
function mktRemove(id) { const t = (mktData?.quotes || []).find(x => x.id === id); if (!confirm('Remove tile "' + (t?.label || id) + '"?')) return; mktCfg({ action: 'remove', id }); }
function mktStripToggle(id, flag) { const t = (mktData?.quotes || []).find(x => x.id === id); if (!t) return; mktCfg({ action: 'update', id, [flag]: flag === 'showYday' ? t.showYday === false : !t.showMonthAgo }); }
function mktStripSeries(id) {
  const t = (mktData?.quotes || []).find(x => x.id === id); if (!t) return;
  const cur = (t.presets || [t.preset]).filter(Boolean).join(',');
  const v = prompt('Curves on this plot (comma list of: oil, wti, gas, gold, btc, sp, nasdaq, dow, sofr — first = left axis, second = right axis):', cur);
  if (v == null) return;
  const presets = v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!presets.length) return;
  mktCfg({ action: 'update', id, presets });
}
let mktDragId = null;
function wireMktDrag() {
  $('markets').querySelectorAll('.m-tile[data-mid]').forEach(el => {
    el.addEventListener('dragstart', e => { mktDragId = el.dataset.mid; e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', e => {
      e.preventDefault(); el.classList.remove('dragover');
      const to = el.dataset.mid;
      if (!mktDragId || mktDragId === to) return;
      const src = (mktData?.quotes || []).find(q => q.id === mktDragId);
      const dst = (mktData?.quotes || []).find(q => q.id === to);
      // dropping onto a LARGE plot groups (source tile is consumed as a secondary series);
      // strips merge with strips, time-series (quote/cds/group) merge with each other.
      const groupable = ['quote', 'cds', 'group'];
      const stripish = t => t.type === 'strip' || t.type === 'ustcurve'; // UST curve joins strips (shared term axis)
      const canMerge = src && dst && dst.size === 'large' &&
        ((stripish(src) && stripish(dst)) || (groupable.includes(src.type) && groupable.includes(dst.type)));
      if (canMerge) {
        return api('/api/markets/config', { method: 'POST', body: JSON.stringify({ action: 'merge', src: src.id, dst: dst.id }) })
          .then(r => { if (r && r.error) toast(r.error); else toast('Grouped'); loadMarkets(); });
      }
      const order = (mktData?.quotes || []).map(q => q.id);
      const from = order.indexOf(mktDragId), t = order.indexOf(to);
      if (from === -1 || t === -1) return;
      order.splice(t, 0, order.splice(from, 1)[0]);
      mktCfg({ action: 'reorder', order });
    });
  });
}
function mktFormToggle() {
  const f = $('mkt-form');
  if (f.style.display !== 'none') { f.style.display = 'none'; return; }
  f.style.display = 'block';
  const cats = Object.entries(MKT_MENU);
  f.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <div class="mk-menu">
        <button class="mk-btn">＋ Add ▾</button>
        <div class="mk-list mk-root">${cats.map(([cat, items], ci) =>
          `<div class="mk-mi mk-sub">${esc(cat)} <span class="mk-arrow">›</span><div class="mk-list mk-sub-list">${items.map((it, ii) =>
            it.cdsMore
              ? `<div class="mk-mi mk-more">More…<div class="mk-more-row" style="display:none"><input class="mk-cin" placeholder="country name"><button class="mk-cgo">Add</button></div></div>`
              : `<div class="mk-mi" data-ci="${ci}" data-ii="${ii}">${esc(it.label)}${it.note ? ` <span class="muted tiny">${esc(it.note)}</span>` : ''}</div>`
          ).join('')}</div></div>`).join('')}</div>
      </div>
      <b class="tiny" style="text-transform:uppercase">Or describe / edit</b>
      <input id="mf-text" placeholder='AAPL · "10-year bund" · "gold plot, 5 years"' style="width:240px">
      <button id="mf-go" onclick="mktAddText()">Go</button>
    </div>
    <div id="mf-stage" style="display:none;margin-top:6px"></div>
    <div id="mf-msg" class="tiny" style="margin-top:4px"></div>`;
  // menu wiring: hover opens via CSS; click also toggles (touch). Item click STAGES the pick.
  f.querySelectorAll('.mk-mi[data-ci]').forEach(el => el.onclick = e => {
    e.stopPropagation();
    const it = cats[+el.dataset.ci][1][+el.dataset.ii];
    f.querySelector('.mk-menu').classList.remove('open');
    mktStage(it);
  });
  f.querySelectorAll('.mk-sub').forEach(el => el.addEventListener('click', () => el.classList.toggle('open')));
  const root = f.querySelector('.mk-menu');
  f.querySelector('.mk-btn').onclick = () => root.classList.toggle('open');
  const more = f.querySelector('.mk-more'), row = f.querySelector('.mk-more-row');
  more.onclick = e => { e.stopPropagation(); row.style.display = ''; row.querySelector('.mk-cin').focus(); };
  const addCountry = () => {
    const c = row.querySelector('.mk-cin').value.trim();
    if (c) mktCfg({ action: 'add', tile: { type: 'cds', country: c, size: 'small' } }).then(() => toast('Added ' + c + ' CDS'));
  };
  row.querySelector('.mk-cgo').onclick = e => { e.stopPropagation(); addCountry(); };
  row.querySelector('.mk-cin').onkeydown = e => { if (e.key === 'Enter') addCountry(); };
  $('mf-text').onkeydown = e => { if (e.key === 'Enter') mktAddText(); };
}
// ---- staged add: pick from the menu (or resolve text) → tweak → Add commits ----
const stockLike = sym => sym && !/^\^/.test(sym) && !/=[FX]$/.test(sym) && !/^DX-Y/.test(sym);
let mktStaged = null;
function mktStage(it) { // it = {label, strip?, tile}
  mktStaged = { label: it.label, stripKey: it.strip || (it.tile.type === 'strip' ? it.tile.preset : null), tile: { ...it.tile } };
  const st = $('mf-stage'), t = mktStaged.tile;
  const canShares = t.type === 'quote' && stockLike(t.sym);
  const isStrip = t.type === 'strip';
  st.style.display = '';
  st.innerHTML = `
    <b>${esc(mktStaged.label)}</b>
    ${mktStaged.stripKey && t.type === 'quote' ? `<label style="margin-left:10px"><input type="checkbox" id="ms-strip"> futures strip</label>` : ''}
    <select id="ms-range" ${isStrip ? 'disabled' : ''} title="time range">${MKT_RANGES.map(r => `<option ${r === (t.range || '1y') ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <input id="ms-shares" type="number" min="0" step="any" placeholder="#shares" style="width:75px" ${canShares ? '' : 'disabled title="shares only apply to stocks/funds"'}>
    <span class="tiny muted">tweak in the text box if you like, then press Add</span>
    <button id="ms-cancel">✕</button>`;
  $('mf-go').textContent = 'Add'; // one action button: Go doubles as the staged-add commit
  const sync = () => {
    const asStrip = $('ms-strip') && $('ms-strip').checked;
    $('ms-range').disabled = asStrip || isStrip;
    $('ms-shares').disabled = asStrip || !canShares;
  };
  if ($('ms-strip')) $('ms-strip').onchange = sync;
  $('ms-cancel').onclick = () => { mktStaged = null; st.style.display = 'none'; st.innerHTML = ''; $('mf-go').textContent = 'Go'; };
}
function mktStageCommit() {
  const t = { ...mktStaged.tile };
  const asStrip = $('ms-strip') && $('ms-strip').checked;
  const tile = asStrip ? { type: 'strip', preset: mktStaged.stripKey, size: 'small' } : t;
  if (!asStrip && tile.type === 'quote') tile.range = $('ms-range').value;
  const sh = parseFloat($('ms-shares').value);
  if (!$('ms-shares').disabled && sh > 0) tile.shares = sh;
  const tweak = $('mf-text').value.trim();
  const finish = () => { $('mf-stage').style.display = 'none'; $('mf-stage').innerHTML = ''; $('mf-text').value = ''; mktStaged = null; $('mf-go').textContent = 'Go'; };
  if (tweak) { // free-text modification of the staged pick — resolver returns the final tile
    $('mf-msg').textContent = 'Applying tweak…';
    return mktResolve(`${mktStaged.label} (${JSON.stringify(tile)}) — modified: ${tweak}`, r => {
      if (!r || r.error || !(r.tile || r.update)) { $('mf-msg').textContent = (r && r.error) || 'could not apply that tweak'; return; }
      const final = r.tile ? { ...tile, ...r.tile } : tile;
      mktCfg({ action: 'add', tile: final }).then(() => { $('mf-msg').textContent = ''; finish(); toast('Added'); });
    });
  }
  const label = mktStaged.label;
  mktCfg({ action: 'add', tile }).then(() => { finish(); toast('Added ' + label); });
}
function mktResolve(text, done) {
  api('/api/markets/resolve', { method: 'POST', body: JSON.stringify({ text }) }).then(r => {
    if (r && r.queued) { $('mf-msg').textContent = 'Resolving via Mac agent…'; return rpcPoll(r.id, done); }
    done(r);
  }).catch(e => { $('mf-msg').textContent = e.message; });
}
// One box adds OR edits: bare tickers stage instantly (no LLM); modifications of existing
// tiles apply directly; resolved stock-like quotes stage so #shares can be entered.
function mktAddText() {
  const text = $('mf-text').value.trim(); if (!text) return;
  const msg = $('mf-msg');
  if (mktStaged) return mktStageCommit(); // Enter in the box while staged = commit with tweak
  if (/^[A-Za-z0-9.^=-]{1,12}$/.test(text) && /[A-Za-z]/.test(text)) { // plain ticker
    const sym = text.toUpperCase();
    $('mf-text').value = '';
    return mktStage({ label: sym, tile: { type: 'quote', sym, label: sym, fmt: 'stock', range: '1y', size: 'small' } });
  }
  msg.textContent = 'Resolving…';
  mktResolve(text, r => {
    if (r && r.update && r.update.id) {
      return mktCfg({ action: 'update', ...r.update }).then(() => { msg.textContent = ''; $('mf-text').value = ''; toast('Updated'); });
    }
    if (!r || r.error || !r.tile) { msg.textContent = (r && r.error) || 'could not resolve'; return; }
    msg.textContent = ''; $('mf-text').value = '';
    const tile = { size: 'small', ...r.tile };
    if (tile.type === 'quote' && stockLike(tile.sym)) return mktStage({ label: tile.label || tile.sym, tile }); // let them add #shares
    mktCfg({ action: 'add', tile }).then(() => toast('Added ' + (tile.label || tile.preset || tile.country || tile.sym)));
  });
}



  // page-level entry points the section markup + other widgets use
  Object.assign(window, { mktFormToggle, mktResize, mktRemove, mktRange, mktAddText, mktStripToggle, mktStripSeries, refreshMarketsWidget: loadMarkets });
  loadMarkets();
}
