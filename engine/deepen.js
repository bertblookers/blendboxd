// Live deepening + viewer records. Port of the widening passes in
// blendboxd/server.py and build_html_records() in blendboxd/output.py.
import { pyRound } from './pymath.js';
import { moodAxes, posterUrl, tmdbUrl } from './models.js';
import { run } from './pipeline.js';

export const MAX_PASSES = 30;
const SEED_STEP = 20;
const GENRE_STEP = 1;
const PAGE_STEP = 2;

// Successively wider configs: the first is `base`; each later pass searches more
// seed films, discover genres and /discover pages.
export function wideningConfigs(base, maxPasses = MAX_PASSES) {
  const passes = [base];
  let { seedFilmsPerAccount: seed, discoverGenres: genres, discoverPages: pages } = base;
  for (let i = 0; i < Math.max(0, maxPasses - 1); i++) {
    seed += SEED_STEP;
    genres += GENRE_STEP;
    pages += PAGE_STEP;
    passes.push({ ...base, seedFilmsPerAccount: seed, discoverGenres: genres, discoverPages: pages });
  }
  return passes;
}

function record(rank, s, names) {
  const m = s.movie;
  return {
    rank,
    title: m.title,
    year: m.year,
    directors: [...m.directors],
    countries: [...m.countries],
    runtime: m.runtime,
    genres: [...m.genres],
    scores: names.map(n => pyRound(s.scores.get(n) || 0.0, 4)),
    combined: pyRound(s.combined, 4),
    tmdb_rating: pyRound(m.voteAverage, 1),
    tmdb_url: tmdbUrl(m),
    poster: posterUrl(m),
    axes: moodAxes(m),
    features: [...s.topFeatures],
    dcon: [...s.driverContribs],
    watched_by: [...s.watchedBy],
  };
}

// Ranked pool -> plain viewer records. Unwatched films get ranks 1..N in score
// order; films a member has seen carry rank null (hidden or dimmed by the viewer).
export function buildRecords(scored, names) {
  let rank = 0;
  return scored.map(s => (s.watchedBy.length ? record(null, s, names) : record(++rank, s, names)));
}

// Run pass after pass until a wider search stops adding finalists. Calls
// onPass({pass, done, result}) after each; `shouldStop()` ends it early (e.g. the
// page was closed or a new blend started).
export async function deepen(state, client, base, { onPass, progress, shouldStop = () => false, maxPasses = MAX_PASSES } = {}) {
  const configs = wideningConfigs(base, maxPasses);
  let prevRanked = -1;
  for (let i = 0; i < configs.length; i++) {
    if (shouldStop()) return;
    const result = await run(state, client, configs[i], i === 0 ? progress : undefined);
    if (shouldStop()) return;
    const passNo = i + 1;
    // The accumulated pool only grows, so the finalist count is monotonic: a pass
    // that adds none has converged.
    const converged = i > 0 && result.scored.length <= prevRanked;
    const done = converged || passNo >= configs.length;
    await onPass({ pass: passNo, done, result });
    if (done) return;
    prevRanked = result.scored.length;
  }
}
