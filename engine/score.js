// Score candidates against each taste profile and blend them. Port of
// blendboxd/score.py (the viewer's combineScores() mirrors combine() below).
import { pyRound, pysum } from './pymath.js';
import { tokenCategory, tokenName } from './models.js';
import { cosine } from './profile.js';

const DRIVER_CATEGORIES = new Set(['genre', 'keyword', 'director']);
export const COMBINE_EPS = 0.02;

export function tasteDrivers(profiles, movieVec, limit = 3) {
  const ranked = [];
  for (const [tok, mw] of movieVec) {
    const cat = tokenCategory(tok);
    if (!DRIVER_CATEGORIES.has(cat)) continue;
    let drive = Infinity;
    for (const [, pv] of profiles) drive = Math.min(drive, (pv.get(tok) || 0.0) * mw);
    if (drive > 0.0) ranked.push([drive, cat, tokenName(tok)]);
  }
  ranked.sort((x, y) => y[0] - x[0]);
  return ranked.slice(0, limit).map(([, cat, name]) => ({ cat, name }));
}

export function driverContributions(profiles, movieVec) {
  const ranked = [];
  for (const [tok, mw] of movieVec) {
    const cat = tokenCategory(tok);
    if (!DRIVER_CATEGORIES.has(cat)) continue;
    const contribs = profiles.map(([, pv]) => pyRound((pv.get(tok) || 0.0) * mw, 3));
    const top = Math.max(...contribs);
    if (top > 0.0) ranked.push([top, cat, tokenName(tok), contribs]);
  }
  ranked.sort((x, y) => y[0] - x[0]);
  return ranked.map(([, cat, name, c]) => ({ cat, name, c }));
}

export function perProfileScore(profile, movieVec, movie, qualityWeight) {
  const taste = Math.max(cosine(profile, movieVec), 0.0);
  const quality = (movie.voteAverage || 0.0) / 10.0;
  return taste + qualityWeight * quality;
}

export function combine(scores, method) {
  const n = scores.length;
  if (n === 0) throw new Error('combine() needs at least one score');
  if (n === 1) return scores[0];
  const s = scores.map(x => Math.max(x, COMBINE_EPS));
  if (method === 'min') return Math.min(...s);
  if (method === 'geometric') return s.reduce((a, b) => a * b, 1) ** (1.0 / n);
  return n / pysum(s.map(x => 1.0 / x));
}

// -> [{movie, scores: Map(name -> score), combined, topFeatures, driverContribs, watchedBy}]
export function rankCandidates(candidates, profiles, vectorizer, qualityWeight, combiner) {
  if (!profiles.length) throw new Error('rankCandidates needs at least one profile');
  const scored = candidates.map(movie => {
    const vec = vectorizer.movieVector(movie);
    const scores = new Map(profiles.map(([name, pv]) => [name, perProfileScore(pv, vec, movie, qualityWeight)]));
    return {
      movie,
      scores,
      combined: combine([...scores.values()], combiner),
      topFeatures: tasteDrivers(profiles, vec),
      driverContribs: driverContributions(profiles, vec),
      watchedBy: [],
    };
  });
  scored.sort((a, b) => (b.combined - a.combined)
    || (b.movie.voteAverage - a.movie.voteAverage)
    || (b.movie.voteCount - a.movie.voteCount));
  return scored;
}
