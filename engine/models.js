// Film features and the three mood axes. Port of blendboxd/models.py: the numbers
// must match it exactly, because the viewer's Vibe panel is shared by both apps.
import { pyRound, pysum } from './pymath.js';

export const LENGTH_R0 = 115.0;
export const LENGTH_K = 0.045;

const COMPLEXITY_GENRE_WEIGHTS = {
  Drama: 1.0, History: 1.0, War: 1.0, Mystery: 1.0,
  Action: -1.0, Comedy: -1.0, Animation: -1.0, Family: -1.0,
};
const ARTHOUSE_KEYWORDS = new Set([
  'surreal', 'nonlinear timeline', 'experimental', 'philosophical', 'dreamlike',
  'art house', 'minimalism', 'avant-garde', 'slow cinema', 'existentialism',
  'abstract', 'meditative', 'ambiguous ending',
]);
const COMPLEXITY_W_GENRE = 1.0;
const COMPLEXITY_W_KEYWORD = 1.2;
const COMPLEXITY_W_NICHE = 0.4;
const ENERGY_GENRE_WEIGHTS = {
  Action: 1.0, Thriller: 1.0, Horror: 1.0,
  Drama: -1.0, Documentary: -1.0, Romance: -1.0,
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const logistic = z => 1.0 / (1.0 + Math.exp(-z));

export function lengthLoad(runtime) {
  if (runtime == null) return 0.5;
  return logistic(LENGTH_K * (runtime - LENGTH_R0));
}

export function complexityLoad(genres, keywords, voteCount) {
  const hits = genres.filter(g => has(COMPLEXITY_GENRE_WEIGHTS, g)).map(g => COMPLEXITY_GENRE_WEIGHTS[g]);
  const genreSignal = hits.length ? pysum(hits) / hits.length : 0.0;
  const kwLower = new Set(keywords.map(k => k.toLowerCase()));
  let nArthouse = 0;
  for (const k of kwLower) if (ARTHOUSE_KEYWORDS.has(k)) nArthouse++;
  const arthouseSignal = Math.min(nArthouse, 3) / 3.0;
  const lv = Math.log10(Math.max(voteCount, 1));
  const nicheSignal = Math.max(-1.0, Math.min(1.0, (2.5 - lv) / 2.5));
  const z = COMPLEXITY_W_GENRE * genreSignal
    + COMPLEXITY_W_KEYWORD * arthouseSignal
    + COMPLEXITY_W_NICHE * nicheSignal;
  return logistic(z);
}

export function energyLoad(genres) {
  const hits = genres.filter(g => has(ENERGY_GENRE_WEIGHTS, g)).map(g => ENERGY_GENRE_WEIGHTS[g]);
  if (!hits.length) return 0.5;
  const mean = pysum(hits) / hits.length;
  return (mean + 1.0) / 2.0;
}

export function moodAxes(m) {
  return {
    length: pyRound(lengthLoad(m.runtime), 4),
    complexity: pyRound(complexityLoad(m.genres, m.keywords, m.voteCount), 4),
    energy: pyRound(energyLoad(m.genres), 4),
  };
}

export const decadeOf = m => (m.year == null ? null : Math.floor(m.year / 10) * 10);
export const tmdbUrl = m => `https://www.themoviedb.org/movie/${m.id}`;
export const posterUrl = m => (m.poster ? `https://image.tmdb.org/t/p/w342${m.poster}` : '');

// Feature tokens (`category::value`) for the taste and candidate vectors. Cached on
// the (immutable) features object: every pass vectorizes the same films again.
export function tokens(m) {
  if (m._tokens) return m._tokens;
  const toks = [];
  for (const g of m.genres) toks.push(`genre::${g}`);
  for (const k of m.keywords) toks.push(`keyword::${k}`);
  for (const d of m.directors) toks.push(`director::${d}`);
  for (const c of m.countries) toks.push(`country::${c}`);
  const decade = decadeOf(m);
  if (decade != null) toks.push(`decade::${decade}s`);
  Object.defineProperty(m, '_tokens', { value: toks, enumerable: false });
  return toks;
}

export const tokenCategory = tok => tok.split('::', 1)[0];
export function tokenName(tok) {
  const at = tok.indexOf('::');
  return at < 0 ? tok : tok.slice(at + 2);
}
