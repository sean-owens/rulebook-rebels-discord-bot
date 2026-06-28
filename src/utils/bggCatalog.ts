import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';

export interface BGGCatalogEntry {
  id: string;
  name: string;
  year: number | null;
  isExpansion: boolean;
  rank: number | null;
}

let entries: BGGCatalogEntry[] = [];
let exactIndex = new Map<string, BGGCatalogEntry[]>();
let wordIndex = new Map<string, number[]>();
let _loaded = false;

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  return normalizeName(s).split(' ').filter(Boolean);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function buildIndexes(csvText: string): void {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return;

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idIdx = headers.indexOf('id');
  const nameIdx = headers.indexOf('name');
  const yearIdx = headers.indexOf('yearpublished');
  const rankIdx = headers.indexOf('rank');
  const isExpIdx = headers.indexOf('is_expansion');

  if (idIdx === -1 || nameIdx === -1) return;

  entries = [];
  exactIndex = new Map();
  wordIndex = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvLine(line);
    const id = fields[idIdx]?.trim();
    const name = fields[nameIdx]?.trim();
    if (!id || !name) continue;

    const year = yearIdx !== -1 ? parseInt(fields[yearIdx], 10) || null : null;
    const rankRaw = rankIdx !== -1 ? parseInt(fields[rankIdx], 10) : NaN;
    const rank = !isNaN(rankRaw) && rankRaw > 0 ? rankRaw : null;
    const isExpansion = isExpIdx !== -1 ? fields[isExpIdx]?.trim() === '1' : false;

    const entry: BGGCatalogEntry = { id, name, year, isExpansion, rank };
    const idx = entries.length;
    entries.push(entry);

    const key = normalizeName(name);
    if (!exactIndex.has(key)) exactIndex.set(key, []);
    exactIndex.get(key)!.push(entry);

    for (const word of tokenize(name)) {
      if (!wordIndex.has(word)) wordIndex.set(word, []);
      wordIndex.get(word)!.push(idx);
    }
  }

  _loaded = true;
}

export function isCatalogLoaded(): boolean {
  return _loaded;
}

export async function loadBGGCatalog(): Promise<void> {
  if (_loaded) return;

  const dir = path.resolve(process.cwd(), 'BGG', 'backup-data');
  if (!fs.existsSync(dir)) {
    console.warn('[BGGCatalog] BGG/backup-data/ not found — name matching disabled');
    return;
  }

  let zipFile: string | undefined;
  try {
    zipFile = fs
      .readdirSync(dir)
      .find((f) => f.startsWith('boardgames_ranks') && f.endsWith('.zip'));
  } catch {
    console.warn('[BGGCatalog] Could not read BGG/backup-data/');
    return;
  }

  if (!zipFile) {
    console.warn('[BGGCatalog] No boardgames_ranks*.zip found — name matching disabled');
    return;
  }

  try {
    const zip = new AdmZip(path.join(dir, zipFile));
    const csvEntry = zip.getEntries().find((e) => e.entryName.endsWith('.csv'));
    if (!csvEntry) {
      console.warn('[BGGCatalog] No CSV file found inside zip');
      return;
    }

    const csvText = csvEntry.getData().toString('utf8');
    buildIndexes(csvText);
    console.log(`[BGGCatalog] Loaded ${entries.length.toLocaleString()} entries from ${zipFile}`);
  } catch (err) {
    console.error('[BGGCatalog] Failed to load catalog:', err);
  }
}

function sortResults(arr: BGGCatalogEntry[]): BGGCatalogEntry[] {
  return [...arr].sort((a, b) => {
    if (a.isExpansion !== b.isExpansion) return a.isExpansion ? 1 : -1;
    const ra = a.rank ?? Infinity;
    const rb = b.rank ?? Infinity;
    return ra - rb;
  });
}

export function searchCatalog(query: string, limit = 5): BGGCatalogEntry[] {
  if (!_loaded || !query.trim()) return [];

  const normQuery = normalizeName(query);

  // Exact normalized match (e.g. "brass birmingham" → "Brass: Birmingham")
  const exactMatches = exactIndex.get(normQuery);
  if (exactMatches && exactMatches.length > 0) {
    return sortResults(exactMatches).slice(0, limit);
  }

  // Token intersection: all words in query must appear in the name
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const sets = tokens.map((t) => new Set(wordIndex.get(t) ?? []));
  sets.sort((a, b) => a.size - b.size);

  const candidates = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    for (const idx of candidates) {
      if (!sets[i].has(idx)) candidates.delete(idx);
    }
  }

  return sortResults([...candidates].map((idx) => entries[idx])).slice(0, limit);
}

// For tests only — load catalog from raw CSV text without needing a zip file
export function _loadFromCsvText(csvText: string): void {
  buildIndexes(csvText);
}

export function _resetCatalog(): void {
  entries = [];
  exactIndex = new Map();
  wordIndex = new Map();
  _loaded = false;
}
