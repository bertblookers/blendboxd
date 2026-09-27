// Turn picked files into export sources. Pure (no DOM), so it's unit-tested.
// Files arrive as [{path, file}] with '/'-separated paths relative to what was
// picked. Every .zip is one export; a folder holding watched.csv or ratings.csv is
// an unzipped export.
export function groupSources(files, rootName = 'folder') {
  const sources = files.filter(f => /\.zip$/i.test(f.path))
    .map(f => ({ name: f.path, kind: 'zip', file: f.file }));
  const dirs = new Set();
  for (const f of files) {
    const m = f.path.match(/^(?:(.*)\/)?(watched|ratings)\.csv$/);
    if (m) dirs.add(m[1] || '');
  }
  // A folder inside another export is part of it (e.g. a list named "Watched" is
  // lists/watched.csv), not an export of its own.
  const within = (dir, root) => root === '' || dir.startsWith(`${root}/`);
  const roots = [...dirs].filter(d => ![...dirs].some(o => o !== d && within(d, o)));
  for (const dir of roots) {
    const prefix = dir ? `${dir}/` : '';
    const inside = files.filter(f => f.path.startsWith(prefix) && /\.csv$/i.test(f.path))
      .map(f => ({ path: f.path.slice(prefix.length), file: f.file }));
    sources.push({ name: dir || rootName, kind: 'folder', files: inside });
  }
  return sources.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
}
