// A small RFC 4180 CSV reader matching Python's csv.DictReader (excel dialect):
// quoted fields may hold commas, doubled quotes and newlines; blank lines are
// skipped; short rows get null for the missing columns.

export function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atStart = true;      // at the start of a field (a quote opens a quoted field)
  let hasContent = false;  // this record has any character (tells [] from [''])
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && atStart) { inQuotes = true; atStart = false; hasContent = true; continue; }
    if (ch === ',') { row.push(field); field = ''; atStart = true; hasContent = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (hasContent) row.push(field);
      rows.push(row);
      row = []; field = ''; atStart = true; hasContent = false;
      continue;
    }
    field += ch; atStart = false; hasContent = true;
  }
  if (hasContent) { row.push(field); rows.push(row); }
  return rows;
}

export function readDicts(text) {
  const rows = parseRows(text).filter(r => r.length > 0);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(r => {
    const d = {};
    header.forEach((key, idx) => { d[key] = idx < r.length ? r[idx] : null; });
    return d;
  });
}
