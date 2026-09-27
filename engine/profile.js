// Taste profiles and the shared feature space. Port of blendboxd/profile.py.
// Vectors are Maps (insertion-ordered, like Python dicts: summation order matters
// for bit-exact parity).
import { pysum } from './pymath.js';
import { tokens, tokenCategory, tokenName } from './models.js';

export function filmWeight(rating, mean, liked, likeBonus) {
  let weight = rating != null ? rating - mean : 0.0;
  if (liked) weight += likeBonus;
  return weight;
}

export function meanRating(account) {
  const ratings = [];
  for (const f of account.films.values()) if (f.rating != null) ratings.push(f.rating);
  return ratings.length ? pysum(ratings) / ratings.length : 0.0;
}

export function computeIdf(movies) {
  let docs = 0;
  const df = new Map();
  for (const m of movies) {
    docs += 1;
    for (const tok of new Set(tokens(m))) df.set(tok, (df.get(tok) || 0) + 1);
  }
  const idf = new Map();
  for (const [tok, count] of df) idf.set(tok, Math.log((docs + 1) / (count + 1)) + 1.0);
  return idf;
}

function l2Normalize(vec) {
  const norm = Math.sqrt(pysum([...vec.values()].map(v => v * v)));
  if (norm === 0.0) return vec;
  const out = new Map();
  for (const [k, v] of vec) out.set(k, v / norm);
  return out;
}

export class Vectorizer {
  constructor(config, idf = null) {
    this.config = config;
    this.idf = idf || new Map();
    this.weights = new Map(); // token -> weight, memoized (idf is fixed per instance)
  }

  weight(tok) {
    let w = this.weights.get(tok);
    if (w !== undefined) return w;
    const cat = tokenCategory(tok);
    const cw = this.config.categoryWeights;
    w = Object.prototype.hasOwnProperty.call(cw, cat) ? cw[cat] : 1.0;
    if (this.config.useIdf) w *= this.idf.has(tok) ? this.idf.get(tok) : 1.0;
    this.weights.set(tok, w);
    return w;
  }

  movieVector(movie) {
    const vec = new Map();
    for (const tok of tokens(movie)) vec.set(tok, this.weight(tok));
    return l2Normalize(vec);
  }

  profileVector(account, featuresById, uriToId) {
    const mean = meanRating(account);
    const raw = new Map();
    for (const film of account.films.values()) {
      const id = uriToId.get(film.uri);
      if (id === undefined) continue;
      const movie = featuresById.get(id);
      if (!movie) continue;
      const weight = filmWeight(film.rating, mean, film.liked, this.config.likeBonus);
      if (weight === 0.0) continue;
      for (const tok of tokens(movie)) raw.set(tok, (raw.get(tok) || 0.0) + weight * this.weight(tok));
    }
    return l2Normalize(raw);
  }
}

export function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  const terms = [];
  for (const [k, v] of a) terms.push(v * (b.get(k) || 0.0));
  return pysum(terms);
}

export function topGenres(profile, limit) {
  const genres = [];
  for (const [tok, w] of profile) {
    if (tokenCategory(tok) === 'genre' && w > 0) genres.push([tokenName(tok), w]);
  }
  genres.sort((x, y) => y[1] - x[1]);
  return genres.slice(0, limit).map(([name]) => name);
}
