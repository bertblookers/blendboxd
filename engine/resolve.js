// Resolve Letterboxd films to TMDb ids via /search/movie. Port of
// blendboxd/resolve.py, including an exact port of difflib.SequenceMatcher.ratio().

export function normalizeTitle(title) {
  if (!title) return '';
  let text = title.normalize('NFKD').replace(/\p{M}/gu, '');
  text = text.toLowerCase().replaceAll('&', ' and ');
  text = text.replace(/[^a-z0-9]+/g, ' ').trim();
  text = text.replace(/^(the|a|an) /, '');
  return text.replace(/\s+/g, ' ').trim();
}

export function yearOf(releaseDate) {
  if (!releaseDate || releaseDate.length < 4) return null;
  const head = releaseDate.slice(0, 4);
  return /^\d{4}$/.test(head) ? Number(head) : null;
}

export const FUZZY_ACCEPT = 0.90;

// difflib.SequenceMatcher(None, a, b).ratio(), ported line for line (no isjunk;
// autojunk on, as in the default constructor).
export function sequenceRatio(a, b) {
  const la = a.length;
  const lb = b.length;
  const b2j = new Map();
  for (let i = 0; i < lb; i++) {
    const elt = b[i];
    if (!b2j.has(elt)) b2j.set(elt, []);
    b2j.get(elt).push(i);
  }
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [elt, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(elt);
  }
  const nothing = [];
  const findLongest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of (b2j.get(a[i]) || nothing)) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    // No junk, so only the non-junk extension loops can ever fire.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi
           && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  const length = la + lb;
  return length ? (2.0 * matches) / length : 1.0;
}

function similarity(a, b) {
  if (!a || !b) return 0.0;
  return sequenceRatio(a, b);
}

// Score TMDb search results against a target title/year; return the best candidate.
export function scoreResults(results, normTitle, year) {
  const ranked = [];
  results.slice(0, 10).forEach((r, i) => {
    const rt = normalizeTitle(r.title ?? '');
    const rot = normalizeTitle(r.original_title ?? '');
    const ry = yearOf(r.release_date);
    const titleExact = Boolean(normTitle) && (normTitle === rt || normTitle === rot);
    const titlePartial = Boolean(normTitle) && !titleExact && (
      rt.includes(normTitle) || normTitle.includes(rt)
      || (Boolean(rot) && (rot.includes(normTitle) || normTitle.includes(rot)))
    );
    const ratio = Math.max(similarity(normTitle, rt), similarity(normTitle, rot));
    let score = 0.0;
    if (titleExact) score += 100.0;
    else if (titlePartial) score += 45.0;
    else if (ratio >= FUZZY_ACCEPT) score += 40.0 * ratio;
    if (year && ry != null) {
      if (ry === year) score += 50.0;
      else if (Math.abs(ry - year) <= 1) score += 25.0;
      else score -= 25.0;
    }
    score += Math.max(0, 10 - i) * 0.5;
    score += Number(r.popularity ?? 0.0) / 10000.0;
    const titleFuzzy = !(titleExact || titlePartial) && ratio >= FUZZY_ACCEPT;
    ranked.push({ score, index: i, titleExact, titlePartial, titleFuzzy, ratio, resultYear: ry, result: r });
  });
  if (!ranked.length) return null;
  ranked.sort((x, y) => (y.score - x.score) || (x.index - y.index));
  return ranked[0];
}

function acceptWithYear(best, year) {
  if (best.titleExact) return true;
  const within = best.resultYear != null && Math.abs(best.resultYear - year) <= 1;
  return within && (best.titlePartial || best.titleFuzzy);
}

const resolution = (film, best, strategy) => ({
  film, tmdbId: best.result.id, matchedTitle: best.result.title ?? null,
  matchedYear: best.resultYear, strategy, note: '',
});

// `client.searchMovie(query, year)` returns {results: [...]}.
export async function resolveFilm(client, film) {
  const norm = normalizeTitle(film.title);
  const year = film.year;
  let nearest = null;

  if (year) {
    const data = await client.searchMovie(film.title, year);
    const best = scoreResults(data.results || [], norm, year);
    if (best) {
      if (acceptWithYear(best, year)) return resolution(film, best, 'search+year');
      nearest = best;
    }
  }

  const data = await client.searchMovie(film.title, null);
  const best = scoreResults(data.results || [], norm, year);
  if (best) {
    if (year) {
      const within = best.resultYear != null && Math.abs(best.resultYear - year) <= 1;
      if (best.titleExact || (within && (best.titlePartial || best.titleFuzzy))) {
        return resolution(film, best, 'search-noyear');
      }
    } else if (best.titleExact || best.titlePartial || best.index === 0) {
      return resolution(film, best, 'search-noyear');
    }
    if (nearest == null || best.score > nearest.score) nearest = best;
  }

  let note = '';
  if (nearest) {
    const r = nearest.result;
    note = `nearest='${r.title}' (${nearest.resultYear}) id=${r.id}`;
  }
  return { film, tmdbId: null, matchedTitle: null, matchedYear: null, strategy: 'unresolved', note };
}
