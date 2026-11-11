import * as V from './src/verify.js';

const LS = 'gcai.verified-counts.v1';
const QUEUE_LEN = 200, PLAN_OPTIONS = [20, 40, 60, 80];
const FIRST_VISIT = localStorage.getItem(LS) === null;
const S = Object.assign({ col: 'cap_on_liability', plan: {}, labels: {}, showTruth: true }, safe(localStorage.getItem(LS)));
function safe(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function save() { localStorage.setItem(LS, JSON.stringify({ col: S.col, plan: S.plan, labels: S.labels, showTruth: S.showTruth })); }

let VAULT = null, RES = null, KEYS = [];
const queues = {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => Math.round(n).toLocaleString('en-US');
const panel = $('#panel');

// ---------------------------------------------------------------- data
async function boot() {
  try {
    const [v, r] = await Promise.all([fetch('data/vault.json'), fetch('data/results.json')]);
    if (!v.ok || !r.ok) throw new Error('HTTP ' + (v.ok ? r.status : v.status));
    VAULT = await v.json(); RES = await r.json();
    KEYS = Object.keys(VAULT.columns);
    VAULT.docs.forEach((d, i) => { d.i = i; d.name = docName(d); });
    renderRecents();
    if (FIRST_VISIT) { // open on a finished example: the first 40 queued checks for liability caps, answered with the CUAD lawyer labels
      const L = (S.labels.cap_on_liability = {}); const { draws } = queue('cap_on_liability');
      for (const i of draws.slice(0, 40)) L[i] = VAULT.columns.cap_on_liability.cells[i].y;
      save(); setTimeout(() => toast('Loaded a finished 40-check review (CUAD lawyer labels). Reset to do it yourself.'), 400);
    }
    window.addEventListener('hashchange', route);
    route();
  } catch (e) {
    panel.innerHTML = `<div class="err" role="alert"><b>Couldn't open this vault</b>The vault data did not load (${esc(e.message)}).<p><button class="btn" onclick="location.reload()">Try again</button></p></div>`;
  }
}
function docName(d) { return d.kind ? `${d.company} – ${d.kind}` : d.company; }
function cells(col = S.col) { return VAULT.columns[col].cells; }
function queue(col = S.col) {
  if (!queues[col]) {
    const pi = V.design(cells(col), 'active');
    queues[col] = { pi, draws: V.drawSequence(pi, QUEUE_LEN, V.mulberry32(20261111 + KEYS.indexOf(col) * 7919)) };
  }
  return queues[col];
}
function labelsOf(col = S.col) { return new Map(Object.entries(S.labels[col] || {}).map(([k, v]) => [+k, v])); }
function planOf(col = S.col) { return S.plan[col] || 40; }
// draws processed so far = longest prefix of the queue whose contracts all have a lawyer label
function progress(col = S.col) {
  const { draws } = queue(col), L = labelsOf(col); let m = 0;
  while (m < draws.length && L.has(draws[m])) m++;
  return { m, next: m < draws.length ? draws[m] : null, unique: new Set(draws.slice(0, m)).size };
}
function estimate(col = S.col) {
  const { pi, draws } = queue(col), { m, unique } = progress(col), L = labelsOf(col);
  const used = draws.slice(0, Math.min(m, planOf(col)));
  const e = V.ppiEstimate(cells(col), pi, used, L, 0.95);
  return { ...e, m: used.length, unique, plan: planOf(col) };
}

// ---------------------------------------------------------------- router
function parse() {
  const h = location.hash.replace(/^#\/?/, '') || 'vault';
  const [path, qs] = h.split('?');
  return { page: path, q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
function go(q, replace = false) {
  const cur = parse().q, nq = { ...cur, ...q };
  for (const k of Object.keys(nq)) if (nq[k] === undefined || nq[k] === null || nq[k] === '') delete nq[k];
  const h = '#/vault?' + new URLSearchParams(nq).toString();
  if (replace) { history.replaceState(null, '', h); route(); } else location.hash = h;
}
let R = null;
function route() {
  R = parse();
  if (R.q.col && VAULT.columns[R.q.col]) S.col = R.q.col;
  if (R.q.plan && PLAN_OPTIONS.includes(+R.q.plan)) S.plan[S.col] = +R.q.plan;
  save();
  render();
}

// ---------------------------------------------------------------- render
function render() {
  const tab = R.q.tab || 'table', drawer = R.q.drawer || 'verify', doc = R.q.doc !== undefined ? +R.q.doc : null;
  const col = VAULT.columns[S.col], cs = col.cells, N = cs.length;
  const ai = V.aiCount(cs), est = estimate(), truth = V.truthCount(cs), pr = progress();
  const done = est.m >= est.plan;
  panel.classList.add('with-drawer');
  panel.innerHTML = `
  <header class="hd">
    <div class="crumb"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5"/><path d="M14 2v6h6"/><path d="M20 8v3"/><circle cx="16.5" cy="16.5" r="3"/><path d="m21 21-2.4-2.4"/></svg>Contract Intelligence<span>/</span><b>EDGAR commercial agreements</b><span class="src">${N} documents · ${KEYS.length} columns</span></div>
    <div class="hd-r"><button class="btn sm" id="keys-btn" aria-label="Keyboard shortcuts"><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>Shortcuts</button><button class="btn sm" id="exp-csv"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>Export</button><button class="btn sm pri" id="add-col"><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"/></svg>Add column</button></div>
  </header>
  <section class="main" id="main">
    <label class="ask"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M17 3v4M15 5h4"/></svg>
      <select id="colsel" aria-label="Question">${KEYS.map(k => `<option value="${k}" ${k === S.col ? 'selected' : ''}>How many of our contracts have ${esc(VAULT.columns[k].label.toLowerCase())}?</option>`).join('')}</select>
      <svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></label>
    <div class="answer">
      <div class="q"><span class="dot"></span>${esc(col.label)} · answered from ${N} contracts</div>
      <div><h2>Found in ${ai} of ${N} contracts</h2><div class="ai">The table's AI values say <b>${ai}</b>. The AI's own probabilities add up to <b>${V.aiExpected(cs).toFixed(0)}</b>.</div></div>
      <div></div>
      <div class="verified">
        <div>
          <div class="vbig">${est.lo === null || est.m < 5 ? `<span class="tag pending">Not verified</span><strong>—</strong><span>${est.m ? `${est.m} of 5 checks before a range appears` : 'no checks yet'}</span>` : `<span class="tag ${done ? '' : 'pending'}">${done ? 'Verified' : 'Provisional'}</span><strong>${fmt(est.lo)}–${fmt(est.hi)}</strong><span>contracts, 95% confidence · best estimate ${fmt(est.est)}</span>`}</div>
          <div class="vsub">${est.m ? `Based on ${est.m} lawyer check${est.m === 1 ? '' : 's'} (${est.unique} contracts) plus the AI values for all ${N}. ${est.m < est.plan ? `Plan: ${est.plan} checks; the range is provisional until they are done.` : 'Plan complete.'}` : `Check a few contracts the AI was least sure about. Every check corrects the count for all ${N}, not just that row.`}</div>
          <div class="prog"><span>${Math.min(est.m, est.plan)} / ${est.plan} checks</span><div class="bar"><i style="width:${Math.min(100, 100 * est.m / est.plan)}%"></i></div></div>
          <div class="acts">
            <button class="btn sm pri" id="go-verify" ${pr.next === null ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>${est.m ? 'Continue checking' : 'Start checking'}</button>
            <span class="plan">Plan <select id="plansel" aria-label="Checks planned">${PLAN_OPTIONS.map(p => `<option value="${p}" ${p === est.plan ? 'selected' : ''}>${p} checks · ±${fmt(planHalf(p))}</option>`).join('')}</select></span>
            <button class="btn sm" id="autofill" title="Fill the remaining planned checks with the CUAD lawyer annotations">Use CUAD labels for the rest</button>
            ${est.m ? '<button class="btn sm" id="reset">Reset</button>' : ''}
          </div>
        </div>
        <div>${rangeSvg(est, ai, truth, N)}
          <label class="plan" style="margin-top:6px"><input type="checkbox" id="truth" ${S.showTruth ? 'checked' : ''}> Show the CUAD true count (${truth}) for this demo</label></div>
      </div>
    </div>
    <div class="tabs" role="tablist"><button role="tab" class="${tab === 'table' ? 'on' : ''}" data-tab="table">Table</button><button role="tab" class="${tab === 'evidence' ? 'on' : ''}" data-tab="evidence">How sure is this?</button></div>
    ${tab === 'table' ? tableHtml(doc) : evidenceHtml()}
  </section>
  <aside class="drawer" aria-label="Side panel">${drawerHtml(drawer, doc)}</aside>`;
  wire(doc);
}
function planHalf(k) { const sd = V.planSd(cells(), queue().pi); return 1.96 * sd / Math.sqrt(k); }

function rangeSvg(est, ai, truth, N) {
  const lo = est.lo ?? Math.max(0, ai - 40), hi = est.hi ?? Math.min(N, ai + 40);
  let a = Math.min(lo, ai, S.showTruth ? truth : lo), b = Math.max(hi, ai, S.showTruth ? truth : hi);
  const pad = Math.max(8, (b - a) * 0.15); a = Math.max(0, a - pad); b = Math.min(N, b + pad);
  const W = 340, X = v => 10 + (W - 20) * (v - a) / Math.max(1, b - a);
  const ticks = niceTicks(a, b, 5);
  return `<div class="range"><svg viewBox="0 0 ${W} 56" role="img" aria-label="AI count ${ai}${est.lo !== null ? `, verified range ${fmt(est.lo)} to ${fmt(est.hi)}` : ''}">
    <line x1="10" x2="${W - 10}" y1="30" y2="30" stroke="#e4d9cc" stroke-width="2"/>
    ${ticks.map(t => `<line x1="${X(t)}" x2="${X(t)}" y1="27" y2="33" stroke="#c4b4a4"/><text x="${X(t)}" y="50" text-anchor="middle">${t}</text>`).join('')}
    ${est.lo !== null && est.m >= 5 ? `<rect x="${X(est.lo)}" y="24" width="${Math.max(2, X(est.hi) - X(est.lo))}" height="12" rx="6" fill="#b8cfd8"/><circle cx="${X(est.est)}" cy="30" r="5" fill="#173c51"/>` : ''}
    <line x1="${X(ai)}" x2="${X(ai)}" y1="14" y2="38" stroke="#aa544b" stroke-width="2"/><text x="${X(ai)}" y="10" text-anchor="middle" fill="#aa544b">AI ${ai}</text>
    ${S.showTruth ? `<path d="M${X(truth)} 38 l-5 8 h10z" fill="none" stroke="#377853" stroke-width="1.6"/><text x="${Math.min(W - 30, X(truth) + 10)}" y="${est.lo !== null ? 18 : 18}" fill="#377853">${truth === ai ? '' : 'true ' + truth}</text>` : ''}
  </svg></div>`;
}
function niceTicks(a, b, n) { const step = [1, 2, 5, 10, 20, 25, 50, 100].find(s => (b - a) / s <= n) || 100; const out = []; for (let t = Math.ceil(a / step) * step; t <= b; t += step) out.push(t); return out; }

// ---------------------------------------------------------------- table
function tableHtml(docSel) {
  const filter = R.q.f || 'all', L = labelsOf(), cs = cells(), query = ($('#q')?.value || '').toLowerCase();
  let rows = VAULT.docs.filter(d => !query || d.name.toLowerCase().includes(query) || d.title.toLowerCase().includes(query));
  if (filter === 'checked') rows = rows.filter(d => L.has(d.i));
  if (filter === 'yes') rows = rows.filter(d => cs[d.i].p >= V.AI_THRESHOLD);
  if (filter === 'disagree') rows = rows.filter(d => L.has(d.i) && L.get(d.i) !== (cs[d.i].p >= V.AI_THRESHOLD ? 1 : 0));
  const cnt = { all: VAULT.docs.length, checked: L.size, yes: V.aiCount(cs), disagree: [...L].filter(([i, v]) => v !== (cs[i].p >= V.AI_THRESHOLD ? 1 : 0)).length };
  const chips = [['all', 'All'], ['yes', 'AI says yes'], ['checked', 'Checked'], ['disagree', 'Corrected']].map(([k, l]) => `<button class="btn sm ${filter === k ? 'pri' : ''}" data-f="${k}">${l} · ${cnt[k]}</button>`).join('');
  return `<div style="display:flex;gap:8px;margin:12px 22px 0;flex-wrap:wrap">${chips}</div>
  <div class="tw" id="tw">${rows.length ? `<table class="vt"><thead><tr><th>File name</th><th>Type</th>${KEYS.map(k => `<th class="${k === S.col ? 'sel' : ''}" data-col="${k}">${esc(VAULT.columns[k].label)}</th>`).join('')}</tr></thead><tbody>
  ${rows.slice(0, 600).map(d => `<tr data-doc="${d.i}" class="${d.i === docSel ? 'cur' : ''}"><td><div class="fn" title="${esc(d.title)}">${PDF}<div><b>${esc(d.name)}</b><small>${d.year || ''} · SEC EDGAR exhibit</small></div></div></td><td>PDF</td>
    ${KEYS.map(k => cellHtml(k, d.i)).join('')}</tr>`).join('')}</tbody></table>` : `<div class="empty"><b>No contracts match</b>${filter === 'disagree' ? 'None of your checks disagreed with the AI yet.' : filter === 'checked' ? 'No contracts checked for this column yet.' : 'Try a different search.'}</div>`}</div>`;
}
const PDF = `<svg class="pdf" viewBox="0 0 22 26" style="stroke:none"><path d="M2 2a2 2 0 0 1 2-2h10l6 6v18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" fill="#e5252a"/><path d="M14 0v4a2 2 0 0 0 2 2h4z" fill="#f59a9c"/><text x="11" y="19" text-anchor="middle" font-family="Inter" font-weight="700" font-size="6.2" fill="#fff">PDF</text></svg>`;
function cellHtml(k, i) {
  const c = VAULT.columns[k].cells[i], yes = c.p >= V.AI_THRESHOLD;
  const lab = (S.labels[k] || {})[i];
  let ck = '';
  if (lab !== undefined) ck = lab === (yes ? 1 : 0) ? `<span class="ck ok" title="Checked by you"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Checked</span>` : `<span class="ck fix" title="You corrected the AI">Corrected → ${lab ? 'Yes' : 'No'}</span>`;
  return `<td class="${k === S.col ? 'sel' : ''}"><span class="cell"><span class="yn ${yes ? 'y' : 'n'}">${yes ? 'Yes' : 'No'}</span><span class="conf" title="AI probability ${(c.p * 100).toFixed(0)}%"><i style="width:${(c.p * 100).toFixed(0)}%"></i></span>${ck}</span></td>`;
}

// ---------------------------------------------------------------- drawer
function drawerHtml(mode, docSel) {
  const seg = `<div class="seg" role="tablist"><button class="${mode === 'verify' ? 'on' : ''}" data-dr="verify"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Verify</button><button class="${mode === 'doc' ? 'on' : ''}" data-dr="doc"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>Contract</button></div>`;
  const head = `<div class="dr-h">${seg}<button class="ib" id="dr-x" aria-label="Close panel"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`;
  if (mode === 'doc') {
    const i = docSel ?? progress().next ?? 0, d = VAULT.docs[i];
    return `${head}<div class="dr-b"><h3>${esc(d.name)}</h3><div class="meta">${esc(d.title)}</div>
      <div class="kv">${KEYS.map(k => { const c = VAULT.columns[k].cells[i], lab = (S.labels[k] || {})[i]; return `<span>${esc(VAULT.columns[k].label)}</span><b style="font-weight:500">${c.p >= .5 ? 'Yes' : 'No'} <small style="color:#857869;font-weight:400">AI ${(c.p * 100).toFixed(0)}%${lab !== undefined ? ` · you: ${lab ? 'Yes' : 'No'}` : ''}</small></b>`; }).join('')}</div>
      <div class="lbl">${VAULT.columns[S.col].cells[i].p >= .5 ? 'AI citation' : 'Closest passage the AI found'} · ${esc(VAULT.columns[S.col].label)}</div><p class="quote">${esc(VAULT.columns[S.col].cells[i].q)}${VAULT.columns[S.col].cells[i].q.length >= 240 ? '…' : ''}</p>
      <button class="btn sm" style="margin-top:14px" data-jump="${i}">Check this contract for ${esc(VAULT.columns[S.col].label.toLowerCase())}</button></div>`;
  }
  const pr = progress(), est = estimate(), cs = cells();
  if (pr.next === null) return `${head}<div class="dr-b"><h3>Queue finished</h3><p class="meta">All ${QUEUE_LEN} queued checks are done.</p></div>`;
  const i = (R.q.jump !== undefined ? +R.q.jump : pr.next), c = cs[i], d = VAULT.docs[i];
  const L = labelsOf(), upcoming = queue().draws.slice(pr.m, pr.m + 8);
  const doneBanner = pr.m >= est.plan && R.q.jump === undefined ? `<div class="reveal" style="margin:0 0 14px;border-style:solid;background:#f1f7f2;border-color:#deece0;color:#235337"><b style="color:#235337">Plan complete: ${est.plan} of ${est.plan} checks.</b> The range is verified. Keep going to tighten it, or switch questions above.</div>` : '';
  return `${head}<div class="dr-b">${doneBanner}
    <div class="lbl" style="margin-top:0">Check ${pr.m + 1}${pr.m + 1 <= est.plan ? ' of ' + est.plan : ' · beyond plan'} · ${c.p > .15 && c.p < .85 ? 'picked because the AI is unsure' : 'random share of the sample'}</div>
    <h3 style="margin-top:6px">${esc(d.name)}</h3><div class="meta">${esc(d.title)}</div>
    <div class="kv"><span>Question</span><b style="font-weight:500">Does it contain ${esc(VAULT.columns[S.col].label.toLowerCase())}?</b><span>AI value</span><b style="font-weight:500">${c.p >= .5 ? 'Yes' : 'No'} · ${(c.p * 100).toFixed(0)}% sure</b><span>Picked</span><b style="font-weight:500">${(queue().pi[i] * cs.length).toFixed(1)}× as often as a random pick</b></div>
    <div class="lbl">${c.p >= .5 ? 'AI citation' : 'Closest passage the AI found'}</div><p class="quote">${esc(c.q)}${c.q.length >= 240 ? '…' : ''}</p>
    <div class="decide"><button class="btn pri" data-ans="1"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Yes, it's there</button><button class="btn" data-ans="0"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>No, it isn't</button></div>
    <div class="hint">Keyboard: <kbd>Y</kbd> yes · <kbd>N</kbd> no · <kbd>J</kbd>/<kbd>K</kbd> move in the table</div>
    <details class="reveal"><summary>What did the CUAD lawyers mark?</summary><p style="margin:8px 0 0"><b>${c.y ? 'Present' : 'Not present'}</b>${c.t ? `: “${esc(c.t)}”` : ''}</p></details>
    <div class="lbl">Up next</div><ul class="qlist">${upcoming.map((j, k) => `<li class="${k === 0 ? 'curq' : ''}"><span>${esc(VAULT.docs[j].name)}</span><em>${L.has(j) ? 'already checked' : 'AI ' + (cs[j].p * 100).toFixed(0) + '%'}</em></li>`).join('')}</ul>
  </div>`;
}

// ---------------------------------------------------------------- evidence
function evidenceHtml() {
  const r = RES.columns[S.col], ks = RES.ks, sims = r.sims;
  const W = 900, H = 260, Lm = 52, Rm = 20, T = 14, B = 36;
  const ymax = Math.max(...ks.map(k => sims.classical[k].meanWidth / 2), Math.abs(r.aiCount - r.truth)) * 1.1;
  const X = k => Lm + (W - Lm - Rm) * (k - ks[0]) / (ks[ks.length - 1] - ks[0]), Y = v => T + (H - T - B) * (1 - v / ymax);
  const line = (m, color, dash = '') => `<path d="${ks.map((k, i) => (i ? 'L' : 'M') + X(k) + ' ' + Y(sims[m][k].meanWidth / 2)).join(' ')}" stroke="${color}" stroke-width="2.2" fill="none" ${dash}/>${ks.map(k => `<circle cx="${X(k)}" cy="${Y(sims[m][k].meanWidth / 2)}" r="3" fill="${color}"/>`).join('')}`;
  const miss = Math.abs(r.aiCount - r.truth);
  const yt = niceTicks(0, ymax, 5);
  const rows = KEYS.map(k => { const c = RES.columns[k]; return `<tr class="${k === S.col ? 'sel' : ''}"><td>${esc(c.label)}</td><td class="num">${c.truth}</td><td class="num">${c.aiCount} (${c.aiCount - c.truth > 0 ? '+' : ''}${c.aiCount - c.truth})</td><td class="num">±${(c.sims.classical[40].meanWidth / 2).toFixed(0)}</td><td class="num"><b>±${(c.sims.active[40].meanWidth / 2).toFixed(0)}</b></td><td class="num">${(c.sims.active[40].coverage * 100).toFixed(1)}%</td></tr>`; }).join('');
  return `<div class="ev">
    <div class="card"><h3>${esc(r.label)}: how far off, by number of checks</h3><p class="cap">Average half-width of the 95% range over ${fmt(RES.reps)} simulated audits per point, using the CUAD lawyer labels as the checks. The AI-only count has no range; the dashed line is how far off it actually is.</p>
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Range half-width by number of checks">
        ${yt.map(v => `<line x1="${Lm}" x2="${W - Rm}" y1="${Y(v)}" y2="${Y(v)}" stroke="#ede3d9"/><text x="${Lm - 8}" y="${Y(v) + 4}" text-anchor="end">±${v}</text>`).join('')}
        ${ks.map(k => `<text x="${X(k)}" y="${H - 14}" text-anchor="middle">${k}</text>`).join('')}<text x="${(Lm + W - Rm) / 2}" y="${H}" text-anchor="middle">contracts checked by a lawyer</text>
        <line x1="${Lm}" x2="${W - Rm}" y1="${Y(miss)}" y2="${Y(miss)}" stroke="#aa544b" stroke-width="2" stroke-dasharray="6 5"/><text x="${Lm + 8}" y="${Y(miss) - 6}" fill="#aa544b">AI-only count is off by ${miss} (and shows no range)</text>
        ${line('classical', '#c4b4a4')}${line('uniform', '#87a7b5')}${line('active', '#173c51')}
      </svg>
      <div class="legend"><span><i style="background:#c4b4a4"></i>Random checks only</span><span><i style="background:#87a7b5"></i>Random checks + AI values</span><span><i style="background:#173c51"></i>Verified count (checks where the AI is unsure + AI values)</span></div></div>
    <div class="card"><h3>All columns at 40 checks</h3><p class="cap">Coverage is how often the 95% range contained the true count. The target is at least 95%.</p>
      <table class="st"><thead><tr><th>Column</th><th>True</th><th>AI says</th><th>Random 40</th><th>Verified 40</th><th>Coverage</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>
  <div class="how">
    <div><h4>Start from the AI's answer</h4><p>Add up the AI's probability for every contract. That is the starting count, and it is usually biased because extraction errors don't cancel out.</p></div>
    <div><h4>Check where it matters</h4><p>Contracts are drawn with probability proportional to the AI's uncertainty, mixed with a uniform share so every contract can be picked. Each check measures the AI's error on that contract.</p></div>
    <div><h4>Correct the whole count</h4><p>The weighted average error (Hansen-Hurwitz, as in prediction-powered inference) is added back. The result is unbiased whatever the AI's accuracy, and the range comes from the spread of those errors.</p></div>
  </div>`;
}

// ---------------------------------------------------------------- wiring
function wire(docSel) {
  $('#colsel').onchange = e => go({ col: e.target.value, jump: undefined });
  $('#plansel').onchange = e => { S.plan[S.col] = +e.target.value; save(); go({ plan: e.target.value }, true); };
  $('#go-verify').onclick = () => go({ drawer: 'verify', jump: undefined });
  $('#truth').onchange = e => { S.showTruth = e.target.checked; save(); render(); };
  $('#autofill').onclick = () => {
    const { draws } = queue(), plan = planOf(); const L = (S.labels[S.col] ||= {}); let n = 0;
    for (const i of draws.slice(0, plan)) if (L[i] === undefined) { L[i] = cells()[i].y; n++; }
    save(); toast(n ? `Filled ${n} checks with CUAD lawyer labels.` : 'All planned checks are already done.'); render();
  };
  const rs = $('#reset'); if (rs) rs.onclick = () => { delete S.labels[S.col]; save(); toast('Checks cleared for this column.'); render(); };
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => go({ tab: b.dataset.tab }));
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => go({ f: b.dataset.f }));
  document.querySelectorAll('[data-dr]').forEach(b => b.onclick = () => go({ drawer: b.dataset.dr }));
  document.querySelectorAll('th[data-col]').forEach(th => th.onclick = () => go({ col: th.dataset.col }));
  document.querySelectorAll('tr[data-doc]').forEach(tr => tr.onclick = () => go({ doc: tr.dataset.doc, drawer: 'doc' }));
  document.querySelectorAll('[data-ans]').forEach(b => b.onclick = () => answer(+b.dataset.ans));
  document.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => go({ drawer: 'verify', jump: b.dataset.jump }));
  $('#dr-x').onclick = () => go({ drawer: R.q.drawer === 'doc' ? 'verify' : 'verify', doc: undefined, jump: undefined });
  $('#exp-csv').onclick = exportCSV;
  $('#add-col').onclick = () => toast('Adding columns runs a new extraction; this demo ships 8 CUAD columns.');
  $('#keys-btn').onclick = keysModal;
  const cur = document.querySelector('tr.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function answer(v) {
  const pr = progress(); const i = R.q.jump !== undefined ? +R.q.jump : pr.next; if (i === null) return;
  (S.labels[S.col] ||= {})[i] = v; save();
  const c = cells()[i], agree = v === (c.p >= .5 ? 1 : 0);
  toast(agree ? 'Checked. The AI was right on this one.' : `Corrected to ${v ? 'Yes' : 'No'}. The count adjusts for contracts like it.`);
  if (R.q.jump !== undefined) go({ jump: undefined }); else render();
}
function exportCSV() {
  const L = labelsOf(), { draws, pi } = queue(), est = estimate(), cs = cells();
  const rows = draws.slice(0, est.m).map((i, k) => ({ order: k + 1, contract: VAULT.docs[i].title, column: VAULT.columns[S.col].label, ai_probability: cs[i].p, ai_value: cs[i].p >= .5 ? 'Yes' : 'No', lawyer_value: L.get(i) ? 'Yes' : 'No', draw_probability: pi[i].toFixed(6), correction: ((L.get(i) - cs[i].p) / pi[i]).toFixed(3) }));
  rows.push({ order: 'summary', contract: `AI count ${V.aiCount(cs)}; verified ${est.lo === null ? 'n/a' : fmt(est.lo) + '-' + fmt(est.hi)} (95%), estimate ${fmt(est.est)}, ${est.m} checks` });
  const csv = V.toCSV(rows, ['order', 'contract', 'column', 'ai_probability', 'ai_value', 'lawyer_value', 'draw_probability', 'correction']);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `verified-count-${S.col}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${est.m} checks and the verified count.`);
}
function keysModal() {
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="kt"><h2 id="kt">Keyboard shortcuts</h2><div class="keys"><kbd>⌘K</kbd><span>Search contracts</span><kbd>Y</kbd><span>Clause is there</span><kbd>N</kbd><span>Clause isn't there</span><kbd>J</kbd><span>Next contract in the table</span><kbd>K</kbd><span>Previous contract</span><kbd>V</kbd><span>Open the verify queue</span><kbd>Esc</kbd><span>Close</span></div><div class="row"><button class="btn pri" id="k-ok">Done</button></div></div>`;
  const close = () => { m.hidden = true; m.innerHTML = ''; }; $('#k-ok').onclick = close; m.onclick = e => { if (e.target === m) close(); }; $('#k-ok').focus();
}
function renderRecents() {
  const items = ['Liability caps across EDGAR agreements', 'Clause for Concern: Uncapped liability', 'Non-competes in distributor deals', 'Change of control before the merger', 'Audit rights we can invoke this year', 'Termination for convenience: vendor list', 'Most favored nation: who has it?', 'Daily Briefing: Today’s Priorities'];
  $('#recents').innerHTML = items.map((t, i) => `<li><a href="#/vault" class="${i === 0 ? 'on' : ''}">${esc(t)}</a></li>`).join('');
}
let toastT; function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2400); }
document.addEventListener('keydown', e => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'Escape') { if (!$('#modal').hidden) { $('#modal').hidden = true; $('#modal').innerHTML = ''; } else if (typing) document.activeElement.blur(); else go({ doc: undefined, drawer: 'verify', jump: undefined }); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !VAULT) return;
  const k = e.key.toLowerCase();
  if ((R.q.drawer || 'verify') === 'verify' && (k === 'y' || k === 'n')) { answer(k === 'y' ? 1 : 0); return; }
  if (k === 'v') { go({ drawer: 'verify' }); return; }
  if (k === 'j' || k === 'k') {
    const ids = [...document.querySelectorAll('tr[data-doc]')].map(tr => +tr.dataset.doc); if (!ids.length) return;
    const cur = R.q.doc !== undefined ? ids.indexOf(+R.q.doc) : -1; const nx = Math.max(0, Math.min(ids.length - 1, cur + (k === 'j' ? 1 : -1)));
    go({ doc: ids[nx], drawer: 'doc' }, true);
  }
  if (e.key === '?') keysModal();
});
$('#q').addEventListener('input', () => { if (VAULT) { const pos = $('#q').selectionStart; render(); $('#q').focus(); $('#q').setSelectionRange(pos, pos); } });
boot();
