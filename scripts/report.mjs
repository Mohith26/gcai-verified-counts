// node scripts/report.mjs -> data/results.json
// 2,000 simulated audits per column, method and check budget, on the committed vault (CUAD truth).
import { readFileSync, writeFileSync } from 'node:fs';
import * as V from '../src/verify.js';

export const KS = [10, 20, 30, 40, 60, 80];
export function computeResults(vault, reps = 2000) {
  const out = { reps, ks: KS, confidence: 0.95, columns: {} };
  for (const [key, col] of Object.entries(vault.columns)) {
    const r = V.simulate(col.cells, { ks: KS, reps, seed: 7 });
    const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, +b.toFixed(4)]))]));
    const acc = col.cells.filter(c => (c.p >= 0.5) === (c.y === 1)).length / col.cells.length;
    out.columns[key] = { label: col.label, truth: r.truth, aiCount: r.ai, aiExpected: +r.aiExpected.toFixed(2), aiAccuracy: +acc.toFixed(4), sims: Object.fromEntries(Object.entries(r.sims).map(([m, v]) => [m, round(v)])) };
  }
  const c = out.columns.cap_on_liability.sims;
  out.headline = {
    column: 'cap_on_liability', checks: 40,
    widthRatioVsClassical: +(c.classical[40].meanWidth / c.active[40].meanWidth).toFixed(2),
    coverageActive: c.active[40].coverage,
    meanWidthActive: c.active[40].meanWidth, meanWidthClassical: c.classical[40].meanWidth,
    worstAiMiss: Object.entries(out.columns).map(([k, v]) => ({ k, miss: v.aiCount - v.truth })).sort((a, b) => Math.abs(b.miss) - Math.abs(a.miss))[0],
    minCoverageActive40: Math.min(...Object.values(out.columns).map(v => v.sims.active[40].coverage)),
  };
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const vault = JSON.parse(readFileSync(new URL('../data/vault.json', import.meta.url)));
  const res = computeResults(vault);
  writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res.headline));
  for (const [k, v] of Object.entries(res.columns)) console.log(k.padEnd(28), v.truth, v.aiCount, v.aiAccuracy, 'act40', v.sims.active[40].coverage, v.sims.active[40].meanWidth, 'cls40', v.sims.classical[40].meanWidth);
}
