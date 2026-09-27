// Python-exact numeric helpers, so the browser engine ranks films the same way the
// Python pipeline does (bit-for-bit where it matters for ordering).

// Python 3.12+ `sum()` over floats: Neumaier compensated summation, seeded with the
// first element (sum() starts from int 0, and 0 + x == x). A plain JS reduce drifts
// from Python in the last bits, which can reorder near-tied films.
export function pysum(values) {
  let total = 0;
  let comp = 0;
  let started = false;
  for (const x of values) {
    if (!started) {
      total = 0 + x;
      started = true;
      continue;
    }
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) comp += (total - t) + x;
    else comp += (x - t) + total;
    total = t;
  }
  if (comp && Number.isFinite(comp)) total += comp;
  return total;
}

// Python `round(x, nd)`: round-half-even on the exact binary value of x. JS's
// toFixed rounds exact ties away from zero instead (round(7.25, 1) is 7.2 in Python,
// 7.3 via toFixed). toFixed(100) is exact for every magnitude this engine rounds.
export function pyRound(x, nd) {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const exact = Math.abs(x).toFixed(100);
  const dot = exact.indexOf('.');
  const intPart = exact.slice(0, dot);
  const frac = exact.slice(dot + 1);
  const kept = intPart + frac.slice(0, nd);
  const rest = frac.slice(nd);
  let roundUp;
  if (rest[0] > '5') roundUp = true;
  else if (rest[0] < '5') roundUp = false;
  else if (/[1-9]/.test(rest.slice(1))) roundUp = true;
  else roundUp = Number(kept[kept.length - 1]) % 2 === 1; // exact tie -> even
  let digits = kept;
  if (roundUp) digits = (BigInt(kept) + 1n).toString().padStart(kept.length, '0');
  const cut = digits.length - nd;
  const text = nd > 0 ? `${digits.slice(0, cut) || '0'}.${digits.slice(cut)}` : digits;
  const value = Number(text);
  return neg ? -value : value;
}
