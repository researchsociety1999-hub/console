export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
export const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const xs = x.slice(-n), ys = y.slice(-n);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
