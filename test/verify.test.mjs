import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as V from '../src/verify.js';
import { computeResults } from '../scripts/report.mjs';

const vault = JSON.parse(readFileSync(new URL('../data/vault.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const toy = (n, seed = 1) => { const r = V.mulberry32(seed); return Array.from({ length: n }, () => { const p = r(); return { p, y: r() < Math.min(1, p * 1.3) ? 1 : 0 }; }); };

test('normal and t quantiles', () => {
  assert.ok(Math.abs(V.normInv(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(V.normInv(0.5)) < 1e-12);
  assert.ok(Math.abs(V.normInv(0.001) + 3.090232) < 1e-5);
  assert.ok(Math.abs(V.tInv(0.975, 10) - 2.228139) < 2e-3);
  assert.ok(Math.abs(V.tInv(0.975, 39) - 2.022691) < 1e-3);
});

test('vault is the real CUAD set: 510 contracts, 8 columns, lawyer counts match CUAD', () => {
  assert.equal(vault.docs.length, 510);
  assert.equal(Object.keys(vault.columns).length, 8);
  const expect = { uncapped_liability: 111, cap_on_liability: 275, termination_for_convenience: 183, change_of_control: 121, non_compete: 119, exclusivity: 180, audit_rights: 214, most_favored_nation: 28 };
  for (const [k, t] of Object.entries(expect)) assert.equal(V.truthCount(vault.columns[k].cells), t, k);
});

test('design probabilities sum to one and are bounded below by the uniform share', () => {
  const cells = vault.columns.non_compete.cells, pi = V.design(cells, 'active', 0.2);
  const s = pi.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-9);
  for (const p of pi) assert.ok(p >= 0.2 / cells.length - 1e-15);
  const u = V.design(cells, 'uniform'); assert.ok(u.every(p => Math.abs(p - 1 / cells.length) < 1e-15));
});

test('draws follow the design (chi-square style check on two buckets)', () => {
  const pi = Float64Array.from([0.7, 0.2, 0.1]); const d = V.drawSequence(pi, 20000, V.mulberry32(5));
  const c = [0, 0, 0]; d.forEach(i => c[i]++);
  assert.ok(Math.abs(c[0] / 20000 - 0.7) < 0.015 && Math.abs(c[2] / 20000 - 0.1) < 0.01);
});

test('estimator is exact when every check agrees with a perfect AI', () => {
  const cells = Array.from({ length: 100 }, (_, i) => ({ p: i < 30 ? 1 : 0, y: i < 30 ? 1 : 0 }));
  const pi = V.design(cells, 'active'); const draws = V.drawSequence(pi, 20, V.mulberry32(1));
  const L = new Map(draws.map(i => [i, cells[i].y]));
  const e = V.ppiEstimate(cells, pi, draws, L);
  assert.equal(e.est, 30);
});

test('property: Hansen-Hurwitz PPI estimate is unbiased for any design (randomised)', () => {
  const cells = toy(300, 11), T = V.truthCount(cells); const rnd = V.mulberry32(99);
  for (const kind of ['uniform', 'active']) {
    const pi = V.design(cells, kind); let s = 0; const reps = 4000;
    for (let r = 0; r < reps; r++) { const d = V.drawSequence(pi, 15, rnd); const L = new Map(d.map(i => [i, cells[i].y])); s += V.ppiEstimate(cells, pi, d, L).est; }
    assert.ok(Math.abs(s / reps - T) < 1.5, `${kind}: mean ${s / reps} vs ${T}`);
  }
});

test('property: 95% range covers the truth at least ~95% of the time on a miscalibrated AI (randomised)', () => {
  // AI probabilities systematically too low: y ~ Bernoulli(min(1, 1.3p))
  const cells = toy(500, 3), T = V.truthCount(cells); const rnd = V.mulberry32(42); let cover = 0; const reps = 1500;
  for (let r = 0; r < reps; r++) { const a = V.audit(cells, 'active', 40, rnd); if (a.lo <= T && T <= a.hi) cover++; }
  assert.ok(cover / reps >= 0.93, `coverage ${cover / reps}`);
});

test('variance floor never makes the range narrower than the sample-variance range', () => {
  const cells = vault.columns.most_favored_nation.cells, pi = V.design(cells, 'active'), rnd = V.mulberry32(8);
  for (let r = 0; r < 200; r++) {
    const d = V.drawSequence(pi, 20, rnd), L = new Map(d.map(i => [i, cells[i].y])), e = V.ppiEstimate(cells, pi, d, L);
    const z = d.map(i => (L.get(i) - cells[i].p) / pi[i]); const m = z.reduce((a, b) => a + b, 0) / z.length;
    const se = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (z.length - 1) / z.length);
    assert.ok(e.se >= se - 1e-9);
  }
});

test('classical estimator: unbiased with uniform draws', () => {
  const cells = toy(200, 21), T = V.truthCount(cells), N = cells.length, rnd = V.mulberry32(4); let s = 0; const reps = 3000;
  const pi = V.design(cells, 'uniform');
  for (let r = 0; r < reps; r++) { const d = V.drawSequence(pi, 25, rnd); const L = new Map(d.map(i => [i, cells[i].y])); s += V.classicalEstimate(N, d, L).est; }
  assert.ok(Math.abs(s / reps - T) < 2, `${s / reps} vs ${T}`);
});

test('planning: checks needed shrink with the square of the target half-width', () => {
  const cells = vault.columns.cap_on_liability.cells, pi = V.design(cells, 'active'), sd = V.planSd(cells, pi);
  const n20 = V.checksFor(20, sd), n10 = V.checksFor(10, sd);
  assert.ok(Math.abs(n10 / n20 - 4) < 0.2);
});

test('active sampling beats random checks on the strong columns (from committed results)', () => {
  for (const k of ['cap_on_liability', 'audit_rights', 'uncapped_liability']) {
    const s = results.columns[k].sims;
    assert.ok(s.active[40].meanWidth < s.classical[40].meanWidth, k);
  }
});

test('every column keeps at least ~95% coverage at 40 checks (from committed results)', () => {
  for (const [k, c] of Object.entries(results.columns)) assert.ok(c.sims.active[40].coverage >= 0.945, `${k}: ${c.sims.active[40].coverage}`);
});

test('headline numbers in data/results.json reproduce from data + code', () => {
  const fresh = computeResults(vault, 2000);
  assert.deepEqual(fresh.headline, results.headline);
  assert.deepEqual(fresh.columns.cap_on_liability, results.columns.cap_on_liability);
  assert.ok(results.headline.widthRatioVsClassical > 2.5);
  assert.ok(results.headline.coverageActive >= 0.95);
});

test('CSV export escapes commas and quotes', () => {
  assert.equal(V.toCSV([{ a: 'x,y', b: 'say "hi"' }], ['a', 'b']), 'a,b\n"x,y","say ""hi"""');
});
