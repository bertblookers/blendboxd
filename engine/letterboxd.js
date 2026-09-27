// Parse Letterboxd data exports into accounts. Port of blendboxd/letterboxd.py plus
// the CLI's labelling (profile.csv username, deduped). An export "source" is
// {name, files}: `files` maps a path inside the export ("ratings.csv",
// "likes/films.csv", …) to its bytes, from an unzipped .zip or a picked folder.
import { unzipSync } from '../vendor/fflate.js';
import { readDicts } from './csv.js';

// Only these members are ever read; skip inflating the rest of the archive.
const WANTED = ['ratings.csv', 'watched.csv', 'likes/films.csv', 'watchlist.csv', 'profile.csv'];
const isWanted = path => WANTED.some(w => path === w || path.endsWith('/' + w));

export function sourceFromZip(name, bytes) {
  const files = unzipSync(bytes, { filter: f => isWanted(f.name.replace(/\\/g, '/')) });
  const map = new Map();
  for (const [path, data] of Object.entries(files)) map.set(path.replace(/\\/g, '/'), data);
  return { name, files: map };
}

const decoder = new TextDecoder('utf-8'); // strips a UTF-8 BOM, like utf-8-sig

function readCsv(source, want) {
  let match = null;
  if (source.files.has(want)) match = want;
  else {
    // Tolerate exports nested under a top-level folder.
    for (const path of source.files.keys()) {
      if (path === want || path.endsWith('/' + want)) { match = path; break; }
    }
  }
  if (match == null) return null;
  return readDicts(decoder.decode(source.files.get(match)));
}

export function parseYear(value) {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (/^[+-]?\d+$/.test(v)) return Number.parseInt(v, 10);
  const digits = [...v].filter(ch => ch >= '0' && ch <= '9').join('');
  return digits.length === 4 ? Number(digits) : null;
}

export function parseRating(value) {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return null;
  const rating = Number(v);
  if (Number.isNaN(rating)) return null;
  if (rating <= 0) return null;
  return Math.max(0.5, Math.min(5.0, rating));
}

// Python's f"title:{title}:{row.get('Year', '')}" (a short row holds None).
function syntheticUri(title, row) {
  const year = !('Year' in row) ? '' : (row.Year == null ? 'None' : row.Year);
  return `title:${title}:${year}`;
}

function entryFor(account, row) {
  const uri = (row['Letterboxd URI'] || '').trim();
  const title = (row.Name || '').trim();
  if (!title) return null;
  const key = uri || syntheticUri(title, row);
  return account.films.get(key)
    || { uri: key, title, year: parseYear(row.Year), rating: null, liked: false, watched: true };
}

export function parseAccount(source, name) {
  const account = { name, films: new Map(), watchlist: new Map() };
  for (const row of readCsv(source, 'watched.csv') || []) {
    const e = entryFor(account, row);
    if (e) account.films.set(e.uri, e);
  }
  for (const row of readCsv(source, 'ratings.csv') || []) {
    const e = entryFor(account, row);
    if (!e) continue;
    const rating = parseRating(row.Rating);
    account.films.set(e.uri, { ...e, rating: rating != null ? rating : e.rating, watched: true });
  }
  for (const row of readCsv(source, 'likes/films.csv') || []) {
    const e = entryFor(account, row);
    if (e) account.films.set(e.uri, { ...e, liked: true, watched: true });
  }
  for (const row of readCsv(source, 'watchlist.csv') || []) {
    const title = (row.Name || '').trim();
    if (!title) continue;
    const uri = (row['Letterboxd URI'] || '').trim() || syntheticUri(title, row);
    account.watchlist.set(uri, { uri, title, year: parseYear(row.Year), rating: null, liked: false, watched: false });
  }
  return account;
}

export const rated = account => [...account.films.values()].filter(f => f.rating != null);
export const liked = account => [...account.films.values()].filter(f => f.liked);
export const tasteFilms = account => [...account.films.values()].filter(f => f.rating != null || f.liked);

export function exportUsername(source) {
  try {
    const rows = readCsv(source, 'profile.csv');
    if (rows && rows.length) return (rows[0].Username || '').trim();
  } catch { /* unreadable profile.csv: fall back to the file name */ }
  return '';
}

// Display name: the Letterboxd username, else the one in a
// `letterboxd-<user>-<date>` file name, else the bare file name.
export function profileLabel(source) {
  const user = exportUsername(source);
  if (user) return user;
  const base = source.name.split('/').pop();
  const stem = base.replace(/\.zip$/i, '');
  const m = stem.match(/^letterboxd-(.+?)-\d{4}-\d{2}-\d{2}/);
  if (m) return m[1];
  return stem || 'profile';
}

// Unique labels (case-insensitive): later collisions become `name (2)`, `name (3)`, …
export function dedupeLabels(labels) {
  const seen = new Set();
  return labels.map(label => {
    let candidate = label;
    let k = 1;
    while (seen.has(candidate.toLowerCase())) { k += 1; candidate = `${label} (${k})`; }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}
