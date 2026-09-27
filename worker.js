// The blend engine, off the main thread. The page sends the picked exports and the
// TMDb key; this worker parses the exports, runs the pipeline, then keeps widening
// the search pass after pass (like the Python app's --serve), posting each pass's
// ranked films back to the page.
import { dedupeLabels, liked, parseAccount, profileLabel, rated, sourceFromZip, tasteFilms } from './engine/letterboxd.js';
import { TMDbAuthError, TMDbClient, networkFetcher } from './engine/tmdb.js';
import { openTmdbCache } from './engine/cache.js';
import { defaultConfig, prepare } from './engine/pipeline.js';
import { buildRecords, deepen } from './engine/deepen.js';

let members = [];   // [{id, label, account}] from the last 'inspect'
let runId = 0;      // bumped to stop an older blend
let cachePromise = null;
const cache = () => (cachePromise ||= openTmdbCache());

const post = msg => self.postMessage(msg);

// A source is {name, kind: 'zip', file} or {name, kind: 'folder', files: [{path, file}]}.
async function loadSource(src) {
  if (src.kind === 'zip') {
    return sourceFromZip(src.name, new Uint8Array(await src.file.arrayBuffer()));
  }
  const files = new Map();
  for (const { path, file } of src.files) files.set(path, new Uint8Array(await file.arrayBuffer()));
  return { name: src.name, files };
}

const hasExportFiles = source => [...source.files.keys()]
  .some(p => /(^|\/)(watched|ratings)\.csv$/.test(p));

async function inspect(sources) {
  const loaded = [];
  const skipped = [];
  for (const src of sources) {
    try {
      const source = await loadSource(src);
      if (!hasExportFiles(source)) {
        skipped.push({ name: src.name, reason: "doesn't look like a Letterboxd export (no watched.csv or ratings.csv)" });
        continue;
      }
      loaded.push(source);
    } catch {
      skipped.push({ name: src.name, reason: "couldn't be read (is it a valid .zip?)" });
    }
  }
  const labels = dedupeLabels(loaded.map(profileLabel));
  members = [];
  loaded.forEach((source, i) => {
    const account = parseAccount(source, labels[i]);
    if (!tasteFilms(account).length) {
      skipped.push({ name: source.name, reason: `${labels[i]} has no rated or liked films yet` });
      return;
    }
    members.push({ id: i, label: labels[i], account, fileName: source.name });
  });
  post({
    type: 'members',
    members: members.map(m => ({
      id: m.id, label: m.label, fileName: m.fileName,
      films: m.account.films.size, rated: rated(m.account).length, liked: liked(m.account).length,
    })),
    skipped,
  });
}

async function blend({ apiKey, include }) {
  const myRun = ++runId;
  const shouldStop = () => myRun !== runId;
  const chosen = members.filter(m => include.includes(m.id));
  const tmdbCache = await cache();
  const fetchRaw = networkFetcher(apiKey);
  const client = new TMDbClient({ fetchRaw, cache: tmdbCache });
  const config = defaultConfig();
  const progress = p => post({ type: 'progress', ...p });
  try {
    const state = await prepare(chosen.map(m => m.account), client, config, progress);
    const unresolved = state.unresolved.map(r => ({ title: r.film.title, year: r.film.year }));
    await deepen(state, client, config, {
      progress,
      shouldStop,
      onPass: async ({ pass, done, result }) => {
        await tmdbCache.flush();
        post({
          type: 'pass', pass, done,
          names: result.names,
          records: buildRecords(result.scored, result.names),
          stats: {
            ...result.stats, requests: fetchRaw.requests, networkErrors: fetchRaw.networkErrors,
            cacheHits: client.cacheHits, cacheMisses: client.misses, cached: tmdbCache.persistent,
          },
          unresolved,
          combiner: config.combiner,
          minVoteCount: config.minVoteCount,
          topN: config.topN,
        });
      },
    });
  } catch (err) {
    if (shouldStop()) return;
    await tmdbCache.flush();
    post({ type: 'error', auth: err instanceof TMDbAuthError, message: String(err && err.message || err) });
  }
}

self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'inspect') inspect(msg.sources);
  else if (msg.type === 'blend') blend(msg);
  else if (msg.type === 'stop') runId++;
};
