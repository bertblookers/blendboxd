// End-to-end orchestration: accounts -> profiles -> candidates -> ranked films.
// Port of blendboxd/pipeline.py (+ candidates.py). Each step keeps Python's
// ordering (resolution order, numeric id sorts, stable sorts) so both apps rank
// the same films the same way.
import { rated, tasteFilms } from './letterboxd.js';
import { normalizeTitle, resolveFilm } from './resolve.js';
import { Vectorizer, computeIdf, topGenres } from './profile.js';
import { rankCandidates } from './score.js';

export const DEFAULT_CATEGORY_WEIGHTS = { genre: 1.0, keyword: 1.0, director: 1.4, country: 0.6, decade: 0.5 };

export function defaultConfig(overrides = {}) {
  return {
    topN: 100,
    minVoteCount: 200,
    seedFilmsPerAccount: 30,
    discoverGenres: 3,
    discoverPages: 2,
    discoverSort: 'vote_count.desc',
    likeBonus: 0.5,
    useIdf: true,
    categoryWeights: { ...DEFAULT_CATEGORY_WEIGHTS },
    qualityWeight: 0.1,
    combiner: 'harmonic',
    workers: 16,
    ...overrides,
  };
}

const byNumber = (a, b) => a - b;

// Order-preserving async map with at most `limit` tasks in flight.
export async function mapPool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- candidates
export function topRatedSeedIds(account, uriToId, limit) {
  const films = rated(account);
  films.sort((a, b) => ((b.rating || 0.0) - (a.rating || 0.0))
    || (Number(b.liked) - Number(a.liked))
    || ((b.year || 0) - (a.year || 0)));
  const ids = [];
  const seen = new Set();
  for (const film of films) {
    const id = uriToId.get(film.uri);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

async function candidatesFromSeeds(client, seedIds) {
  const pool = new Set();
  const movies = await mapPool(seedIds, 16, id => client.movie(id));
  for (const m of movies) for (const id of m.recs) pool.add(id);
  return pool;
}

async function candidatesFromDiscover(client, genreNames, genreMap, config) {
  const pool = new Set();
  const chosen = genreNames.filter(g => genreMap.has(g)).slice(0, config.discoverGenres);
  const jobs = [];
  for (const name of chosen) {
    const gid = String(genreMap.get(name));
    for (let page = 1; page <= config.discoverPages; page++) jobs.push([gid, page]);
  }
  const pages = await mapPool(jobs, 16, ([gid, page]) =>
    client.discover(gid, config.minVoteCount, config.discoverSort, page));
  for (const data of pages) for (const id of data.ids || []) pool.add(id);
  return pool;
}

// ------------------------------------------------------------------ pipeline
// One-time steps 1-3 for a set of parsed accounts: resolve the rated + liked
// films and fetch their features. Returns the reusable "deepen state".
export async function prepare(accounts, client, config, progress = () => {}) {
  const signal = new Map();
  for (const account of accounts) {
    for (const film of tasteFilms(account)) if (!signal.has(film.uri)) signal.set(film.uri, film);
  }
  const films = [...signal.values()];
  const resolutions = await mapPool(films, config.workers, f => resolveFilm(client, f),
    (done, total) => progress({ phase: 'resolve', done, total }));
  const uriToId = new Map();
  const unresolved = [];
  resolutions.forEach((res, i) => {
    if (res.tmdbId != null) uriToId.set(films[i].uri, res.tmdbId);
    else unresolved.push(res);
  });

  const ratedIds = [...new Set(uriToId.values())].sort(byNumber);
  const ratedFeatures = new Map();
  const movies = await mapPool(ratedIds, config.workers, id => client.movie(id),
    (done, total) => progress({ phase: 'rated', done, total }));
  ratedIds.forEach((id, i) => { if (movies[i].features) ratedFeatures.set(id, movies[i].features); });

  return { accounts, uriToId, unresolved, ratedFeatures, candidateFeatures: new Map() };
}

// Steps 4-8 on a prepared state. `state.candidateFeatures` accumulates across
// passes (mutated in place), so a wider pass only fetches the new ids.
export async function run(state, client, config, progress = () => {}) {
  const { accounts, uriToId, ratedFeatures, candidateFeatures } = state;

  // 4. Provisional (no-IDF) profiles pick the discover genres.
  const provisional = new Vectorizer(config, new Map());
  let discoverGenres = [];
  for (const account of accounts) {
    const prov = provisional.profileVector(account, ratedFeatures, uriToId);
    discoverGenres.push(...topGenres(prov, config.discoverGenres));
  }
  discoverGenres = [...new Set(discoverGenres)];

  // 5. Union recommendation seeds + genre discovery.
  let seeds = [];
  for (const account of accounts) seeds.push(...topRatedSeedIds(account, uriToId, config.seedFilmsPerAccount));
  seeds = [...new Set(seeds)];
  progress({ phase: 'candidates', done: 0, total: 0 });
  const pool = await candidatesFromSeeds(client, seeds);
  const genreMap = await client.genreMap();
  for (const id of await candidatesFromDiscover(client, discoverGenres, genreMap, config)) pool.add(id);

  // 6. Features for the candidate ids not fetched on an earlier pass.
  const fetchIds = [...pool].filter(id => !candidateFeatures.has(id)).sort(byNumber);
  const movies = await mapPool(fetchIds, config.workers, id => client.movie(id),
    (done, total) => progress({ phase: 'candidates', done, total }));
  fetchIds.forEach((id, i) => { if (movies[i].features) candidateFeatures.set(id, movies[i].features); });

  // 7. Watched lookup: resolved ids + (normalized title, year) of every watched film.
  const watchedLookup = accounts.map(account => {
    const ids = new Set();
    const keys = new Set();
    for (const [uri, film] of account.films) {
      keys.add(`${normalizeTitle(film.title)}\u0000${film.year}`);
      const id = uriToId.get(uri);
      if (id !== undefined) ids.add(id);
    }
    return [account.name, ids, keys];
  });
  const watchedBy = movie => {
    const norm = normalizeTitle(movie.title);
    const seen = [];
    for (const [name, ids, keys] of watchedLookup) {
      if (ids.has(movie.id)) seen.push(name);
      else if (movie.year == null) { if (keys.has(`${norm}\u0000null`)) seen.push(name); }
      else if ([0, -1, 1].some(dy => keys.has(`${norm}\u0000${movie.year + dy}`))) seen.push(name);
    }
    return seen;
  };
  const finalists = [...candidateFeatures.values()].filter(m => m.voteCount >= config.minVoteCount);

  // 8. IDF-weighted profiles over the whole corpus, then score.
  const corpus = new Map(ratedFeatures);
  for (const [id, m] of candidateFeatures) corpus.set(id, m);
  const idf = config.useIdf ? computeIdf(corpus.values()) : new Map();
  const vectorizer = new Vectorizer(config, idf);
  const profiles = accounts.map(a => [a.name, vectorizer.profileVector(a, corpus, uriToId)]);
  progress({ phase: 'score', done: 0, total: finalists.length });
  const scored = rankCandidates(finalists, profiles, vectorizer, config.qualityWeight, config.combiner);
  let watchedCount = 0;
  for (const s of scored) {
    s.watchedBy = watchedBy(s.movie);
    if (s.watchedBy.length) watchedCount++;
  }

  return {
    scored,
    names: accounts.map(a => a.name),
    stats: {
      ratedResolved: uriToId.size,
      unresolved: state.unresolved.length,
      candidatePool: pool.size,
      finalists: finalists.length,
      ranked: scored.length,
      watchedTagged: watchedCount,
      recommendations: scored.length - watchedCount,
    },
  };
}
