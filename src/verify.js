// Verified counts for Contract Intelligence.
// Question: "In how many of our N contracts is X present?" The AI has a value for every contract;
// a lawyer can check a few. This module turns AI values + a small checked sample into an
// unbiased estimate with a confidence interval (prediction-powered inference with an active,
// uncertainty-weighted sampling design), and plans how many checks a target precision needs.
// Pure functions; runs in the browser and in Node.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ distributions
// Standard normal quantile (Acklam's rational approximation, |err| < 1.2e-9 after one Newton step skipped).
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
// Student-t quantile via the Cornish-Fisher expansion (Abramowitz & Stegun 26.7.5), good for df >= 3.
export function tInv(p, df) {
  const z = normInv(p);
  if (!isFinite(df) || df > 1e6) return z;
  const z3 = z ** 3, z5 = z ** 5, z7 = z ** 7, z9 = z ** 9;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
    + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
    + (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df ** 4);
}

// ------------------------------------------------------------ the AI answer
export const AI_THRESHOLD = 0.5;
export function aiCount(cells) { let c = 0; for (const x of cells) if (x.p >= AI_THRESHOLD) c++; return c; }
export function aiExpected(cells) { let s = 0; for (const x of cells) s += x.p; return s; }
export function truthCount(cells) { let c = 0; for (const x of cells) c += x.y; return c; }

// ------------------------------------------------------------ sampling designs
// Active design: pi_i proportional to the AI's own uncertainty sqrt(p(1-p)) (optimal for the
// rectifier when p is calibrated), mixed with uniform so no contract has a tiny probability.
export function design(cells, kind = 'active', mix = 0.2) {
  const n = cells.length;
  if (kind === 'uniform') return new Float64Array(n).fill(1 / n);
  const u = cells.map(c => Math.sqrt(Math.max(0, c.p * (1 - c.p))));
  const s = u.reduce((a, b) => a + b, 0);
  const pi = new Float64Array(n);
  for (let i = 0; i < n; i++) pi[i] = (1 - mix) * (s > 0 ? u[i] / s : 1 / n) + mix / n;
  return pi;
}
// Draw indices i.i.d. from pi (with replacement) by inverse CDF.
export function drawSequence(pi, k, rnd) {
  const cdf = new Float64Array(pi.length); let acc = 0;
  for (let i = 0; i < pi.length; i++) { acc += pi[i]; cdf[i] = acc; }
  const out = [];
  for (let j = 0; j < k; j++) {
    const u = rnd() * acc; let lo = 0, hi = pi.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
    out.push(lo);
  }
  return out;
}

// ------------------------------------------------------------ estimators
// Hansen-Hurwitz prediction-powered estimate of the total T = sum_i Y_i:
//   T_hat = sum_i f_i + mean_d z_d,  z_d = (Y_d - f_d) / pi_d   (draws d ~ pi, with replacement)
// Unbiased for any f and any pi > 0. Var(T_hat) = Var(z)/n, estimated by the sample variance.
// labels: Map index -> 0/1 (a contract drawn twice is checked once).
export function ppiEstimate(cells, pi, draws, labels, conf = 0.95) {
  const N = cells.length, base = aiExpected(cells), n = draws.length;
  if (n === 0) return { n: 0, est: base, lo: null, hi: null, se: null, base };
  const z = draws.map(i => (labels.get(i) - cells[i].p) / pi[i]);
  const mean = z.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? z.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : NaN;
  // Small samples of a heavy-tailed z underestimate the variance (a rare missed clause shows up
  // in few draws). Floor the per-draw variance at the design's planning variance.
  const vPlan = planSd(cells, pi) ** 2;
  const se = Math.sqrt(Math.max(v, vPlan) / n), q = tInv(1 - (1 - conf) / 2, Math.max(1, n - 1));
  const est = base + mean;
  return { n, est, lo: n > 1 ? Math.max(0, est - q * se) : null, hi: n > 1 ? Math.min(N, est + q * se) : null, se, base, correction: mean, floored: vPlan > v };
}
// Classical: labels only, uniform draws: T_hat = N * mean(Y).
export function classicalEstimate(N, draws, labels, conf = 0.95) {
  const n = draws.length; if (!n) return { n: 0, est: null, lo: null, hi: null, se: null };
  const y = draws.map(i => labels.get(i)); const m = y.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? y.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) : NaN;
  const se = N * Math.sqrt(v / n), q = tInv(1 - (1 - conf) / 2, Math.max(1, n - 1));
  // all-0 or all-1 samples give se = 0; fall back to a Wilson-style half-width so the interval is not degenerate
  const seAdj = se > 0 ? se : N * Math.sqrt(0.25 / (n + 4)) * 0.5;
  return { n, est: N * m, lo: n > 1 ? Math.max(0, N * m - q * seAdj) : null, hi: n > 1 ? Math.min(N, N * m + q * seAdj) : null, se: seAdj };
}

// Expected standard error per draw for a design, assuming the AI probabilities are calibrated
// (used only for planning; the reported interval never relies on it).
export function planSd(cells, pi) {
  let s = 0; for (let i = 0; i < cells.length; i++) { const p = cells[i].p; s += p * (1 - p) / pi[i]; }
  return Math.sqrt(s); // Var(z) = sum pi_i * E[(Y-f)^2]/pi_i^2 - 0 (E[Y-f]=0 under calibration)
}
export function checksFor(halfWidth, sd, conf = 0.95) { const q = normInv(1 - (1 - conf) / 2); return Math.ceil((q * sd / halfWidth) ** 2); }

// ------------------------------------------------------------ audit simulation
// One audit: draw k contracts by design, "check" them against the lawyer annotation, estimate.
export function audit(cells, kind, k, rnd, conf = 0.95) {
  const pi = design(cells, kind === 'classical' ? 'uniform' : kind);
  const draws = drawSequence(pi, k, rnd);
  const labels = new Map(draws.map(i => [i, cells[i].y]));
  const r = kind === 'classical' ? classicalEstimate(cells.length, draws, labels, conf) : ppiEstimate(cells, pi, draws, labels, conf);
  return { ...r, unique: labels.size };
}
export function simulate(cells, { kinds = ['classical', 'uniform', 'active'], ks = [10, 20, 30, 40, 60, 80], reps = 2000, seed = 7, conf = 0.95 } = {}) {
  const T = truthCount(cells), out = {};
  for (const kind of kinds) {
    out[kind] = {};
    const rnd = mulberry32(seed + kind.length * 101);
    for (const k of ks) {
      let cover = 0, width = 0, abs = 0, uniq = 0;
      for (let r = 0; r < reps; r++) {
        const b = audit(cells, kind, k, rnd, conf);
        if (b.lo !== null && b.lo <= T && T <= b.hi) cover++;
        width += b.hi - b.lo; abs += Math.abs(b.est - T); uniq += b.unique;
      }
      out[kind][k] = { coverage: cover / reps, meanWidth: width / reps, meanAbsError: abs / reps, meanUnique: uniq / reps };
    }
  }
  return { truth: T, ai: aiCount(cells), aiExpected: aiExpected(cells), sims: out };
}

export function toCSV(rows, cols) {
  const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}
