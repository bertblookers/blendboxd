// A cached, polite TMDb v3 client for the browser. Port of blendboxd/tmdb.py with
// one big difference: it caches a *compact* form of each response (the ~1 KB of
// fields the engine reads) instead of the raw JSON, which for a film with full
// credits can run to 300 KB. The cache itself is injected (IndexedDB in the
// browser, a Map in tests); `fetchRaw` is injected too, so tests run offline.
import { yearOf } from './resolve.js';

export const BASE = 'https://api.themoviedb.org/3';
// Bump when a compact shape changes: older cache entries then read as misses.
export const CACHE_SCHEMA = 'v1';

export class TMDbAuthError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isError = raw => raw != null && Object.prototype.hasOwnProperty.call(raw, '__status_code__');

// Python's cache key: "path?k=v&…" over the sorted params (api_key excluded).
export function canonicalKey(path, params) {
  const clean = Object.fromEntries(Object.entries(params || {}).filter(([k]) => k !== 'api_key'));
  const keys = Object.keys(clean).sort();
  return path.replace(/^\/+|\/+$/g, '') + '?' + keys.map(k => `${k}=${clean[k]}`).join('&');
}

// --------------------------------------------------------------- compaction
export function compactMovie(raw) {
  if (isError(raw) || raw == null || !('id' in raw)) return { features: null, recs: recommendationIds(raw) };
  return { features: parseMovie(raw), recs: recommendationIds(raw) };
}

// Port of features.parse_movie (shape: the fields MovieFeatures carries).
export function parseMovie(raw) {
  if (isError(raw) || raw == null || !('id' in raw)) return null;
  const names = list => (list || []).filter(x => x && x.name).map(x => x.name);
  const kwBlock = raw.keywords || {};
  const kwList = kwBlock.keywords || kwBlock.results || [];
  const crew = (raw.credits || {}).crew || [];
  return {
    id: Math.trunc(Number(raw.id)),
    title: raw.title || raw.original_title || '',
    year: yearOf(raw.release_date),
    genres: names(raw.genres),
    keywords: names(kwList),
    directors: crew.filter(c => c && c.job === 'Director' && c.name).map(c => c.name),
    countries: names(raw.production_countries),
    lang: raw.original_language || '',
    runtime: raw.runtime || null,
    voteAverage: Number(raw.vote_average || 0.0),
    voteCount: Math.trunc(Number(raw.vote_count || 0)),
    poster: raw.poster_path || '',
  };
}

// Port of features.recommendation_ids: appended recommendations + similar ids.
export function recommendationIds(raw) {
  const ids = [];
  if (raw == null) return ids;
  for (const key of ['recommendations', 'similar']) {
    const block = raw[key] || {};
    for (const r of block.results || []) if (Number.isInteger(r && r.id)) ids.push(r.id);
  }
  return ids;
}

const compactSearch = raw => ({
  results: ((raw && raw.results) || []).slice(0, 10).map(r => ({
    id: r.id, title: r.title ?? null, original_title: r.original_title ?? null,
    release_date: r.release_date ?? null, popularity: r.popularity ?? 0,
  })),
});
const compactDiscover = raw => ({
  ids: ((raw && raw.results) || []).map(r => r && r.id).filter(Number.isInteger),
});
const compactGenres = raw => ({
  genres: ((raw && raw.genres) || []).map(g => ({ id: g.id, name: g.name })),
});

// ------------------------------------------------------------------ network
// fetchRaw(path, params) for the real API: returns the parsed JSON, or a
// {__status_code__} sentinel like the Python client (404 is a definitive answer;
// 599 means retries ran out). 401 throws: every later request would fail too.
export function networkFetcher(apiKey, { maxConcurrent = 8, minInterval = 30, maxRetries = 4, timeoutMs = 20000 } = {}) {
  let active = 0;
  const waiters = [];
  let nextStart = 0;
  const acquire = async () => {
    while (active >= maxConcurrent) await new Promise(r => waiters.push(r));
    active++;
    const now = Date.now();
    const at = Math.max(now, nextStart);
    nextStart = at + minInterval;
    if (at > now) await sleep(at - now);
  };
  const release = () => { active--; const w = waiters.shift(); if (w) w(); };

  const fetchRaw = async (path, params) => {
    const url = new URL(`${BASE}/${path.replace(/^\/+/, '')}`);
    url.searchParams.set('api_key', apiKey);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await acquire();
      let resp;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          resp = await fetch(url, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err;
        release();
        await sleep(Math.min(2 ** attempt, 8) * 1000);
        continue;
      }
      release();
      fetchRaw.requests++;
      if (resp.status === 200) return resp.json();
      if (resp.status === 404) return { __status_code__: 404 };
      if (resp.status === 401) throw new TMDbAuthError('TMDb rejected the API key (401).');
      if (resp.status === 429) {
        const ra = Number.parseFloat(resp.headers.get('Retry-After') || '1');
        await sleep(((Number.isFinite(ra) ? ra : 1) + 0.5) * 1000);
        continue;
      }
      if (resp.status >= 500) { await sleep(Math.min(2 ** attempt, 8) * 1000); continue; }
      return { __status_code__: resp.status, __error__: (await resp.text()).slice(0, 200) };
    }
    fetchRaw.networkErrors++;
    const detail = lastErr ? `network error: ${lastErr}` : 'max retries exceeded';
    return { __status_code__: 599, __error__: detail };
  };
  fetchRaw.requests = 0;
  fetchRaw.networkErrors = 0;
  return fetchRaw;
}

// ------------------------------------------------------------------- client
export class TMDbClient {
  // cache: {get(key) -> value|undefined, set(key, value)}; fetchRaw as above.
  constructor({ fetchRaw, cache }) {
    this.fetchRaw = fetchRaw;
    this.cache = cache;
    this.inflight = new Map();
    this.cacheHits = 0;
    this.misses = 0;
  }

  async get(path, params, compact) {
    const key = `${CACHE_SCHEMA}|${canonicalKey(path, params)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) { this.cacheHits++; return hit; }
    // Coalesce concurrent requests for the same key (e.g. a film two members rated).
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = (async () => {
      this.misses++;
      const raw = await this.fetchRaw(path, params);
      const status = isError(raw) ? raw.__status_code__ : null;
      const value = status == null ? compact(raw) : { ...compact(raw), status };
      // Cache successes and definitive 404s only; transient failures must refetch.
      if (status == null || status === 404) this.cache.set(key, value);
      return value;
    })();
    this.inflight.set(key, job);
    try { return await job; } finally { this.inflight.delete(key); }
  }

  // Details + keywords + credits + recommendations + similar, compacted to
  // {features|null, recs: [ids]}.
  movie(id) {
    return this.get(`movie/${id}`, { append_to_response: 'keywords,credits,recommendations,similar' }, compactMovie);
  }

  searchMovie(query, year) {
    const params = { query, include_adult: 'false' };
    if (year) params.year = year;
    return this.get('search/movie', params, compactSearch);
  }

  discover(withGenres, voteCountGte, sortBy, page) {
    return this.get('discover/movie', {
      with_genres: withGenres, 'vote_count.gte': voteCountGte, sort_by: sortBy,
      page, include_adult: 'false',
    }, compactDiscover);
  }

  async genreMap() {
    const data = await this.get('genre/movie/list', { language: 'en' }, compactGenres);
    return new Map((data.genres || []).map(g => [g.name, g.id]));
  }
}
