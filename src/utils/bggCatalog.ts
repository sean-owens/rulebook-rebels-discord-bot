import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { readJson, writeJson } from './db';
import { searchBGG } from './bgg';

const DISCOVERED_ENTRIES_FILE = 'bgg_discovered_entries.json';

export interface BGGCatalogEntry {
  id: string;
  name: string;
  year: number | null;
  isExpansion: boolean;
  rank: number | null;
}

let entries: BGGCatalogEntry[] = [];
let exactIndex = new Map<string, BGGCatalogEntry[]>();
let idIndex = new Map<string, BGGCatalogEntry>();
let wordIndex = new Map<string, number[]>();
let sortedWords: string[] = [];
let _loaded = false;

function lowerBound(arr: string[], target: string): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function prefixMatchIndices(prefix: string): Set<number> {
  const result = new Set<number>();
  const start = lowerBound(sortedWords, prefix);
  for (let i = start; i < sortedWords.length && sortedWords[i].startsWith(prefix); i++) {
    for (const idx of wordIndex.get(sortedWords[i]) ?? []) {
      result.add(idx);
    }
  }
  return result;
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-]/g, ' ')          // treat hyphens as word separators
    .replace(/[^a-z0-9\s]/g, '')  // strip remaining punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Bounded edit distance (Levenshtein) — short-circuits once it's clear the
// distance will exceed maxDist, so a handful of wildly different tokens
// (the common case) never runs the full O(n*m) comparison.
export function editDistanceAtMost(a: string, b: string, maxDist: number): boolean {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  const n = b.length;
  let prevRow = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const currRow = new Array<number>(n + 1);
    currRow[0] = i;
    let rowMin = currRow[0];
    for (let j = 1; j <= n; j++) {
      currRow[j] =
        a[i - 1] === b[j - 1]
          ? prevRow[j - 1]
          : 1 + Math.min(prevRow[j - 1], prevRow[j], currRow[j - 1]);
      rowMin = Math.min(rowMin, currRow[j]);
    }
    if (rowMin > maxDist) return false; // every cell this row already exceeds the bound
    prevRow = currRow;
  }
  return prevRow[n] <= maxDist;
}

// A query token counts as matching a name token either the existing way
// (exact prefix — "wing" → "Wingspan") or, for tokens long enough that a
// single-letter slip is unambiguous, when it's a near-miss of the name
// token's own leading prefix (e.g. "dual" → "Duel of ...", a common
// dual/duel homophone typo the strict prefix check can't see at all).
// Short tokens (3 letters or fewer — "of", "a", "war") skip the fallback
// entirely, since a 1-edit tolerance on something that short matches almost
// anything and would defeat the point of "fuzzy" filtering results down.
function tokenMatches(queryToken: string, nameToken: string): boolean {
  if (nameToken.startsWith(queryToken)) return true;
  if (queryToken.length <= 3) return false;
  const candidate = nameToken.slice(0, Math.min(nameToken.length, queryToken.length + 1));
  return editDistanceAtMost(queryToken, candidate, 1);
}

export function matchesFuzzy(query: string, name: string): boolean {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return false;
  const nTokens = tokenize(name);
  return qTokens.every((qt) => nTokens.some((nt) => tokenMatches(qt, nt)));
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
  idIndex = new Map();
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
    idIndex.set(id, entry);

    for (const word of tokenize(name)) {
      if (!wordIndex.has(word)) wordIndex.set(word, []);
      wordIndex.get(word)!.push(idx);
    }
  }

  sortedWords = [...wordIndex.keys()].sort();
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

  // Union in games discovered via live-search fallback on a prior run (see
  // searchCatalogWithFallback) — kept in its own try/catch so a transient S3
  // hiccup here can't undo a catalog that already loaded fine from the zip.
  try {
    const discovered = await readJson<BGGCatalogEntry[]>(DISCOVERED_ENTRIES_FILE, []);
    for (const entry of discovered) addCatalogEntry(entry);
  } catch (err) {
    console.error('[BGGCatalog] Failed to load discovered entries:', err);
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

// Non-expansion entries with a real rank, sorted best-first, capped at
// `limit` — the pool the weekly board game challenge picks from.
export function getTopRankedGames(limit = 500): BGGCatalogEntry[] {
  return entries
    .filter((e) => !e.isExpansion && e.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .slice(0, limit);
}

// Looks up a specific entry by BGG id — used to resolve an explicit
// autocomplete pick (marketplace.ts encodes the id into the suggestion's
// value) without re-running a name search, which could return a different
// entry than the one actually offered/clicked.
export function getCatalogEntryById(id: string): BGGCatalogEntry | undefined {
  return idIndex.get(id);
}

// `skipExact` bypasses the exact-name shortcut so a query that is itself a
// complete title (e.g. "ticket to ride") still returns its longer siblings
// ("Ticket to Ride: Europe") — used by the challenge's ambiguity check.
export function searchCatalog(query: string, limit = 5, opts: { skipExact?: boolean } = {}): BGGCatalogEntry[] {
  if (!_loaded || !query.trim()) return [];

  const normQuery = normalizeName(query);

  // Exact normalized match (e.g. "brass birmingham" → "Brass: Birmingham")
  const exactMatches = opts.skipExact ? undefined : exactIndex.get(normQuery);
  if (exactMatches && exactMatches.length > 0) {
    return sortResults(exactMatches).slice(0, limit);
  }

  // Prefix intersection: every query token must prefix-match at least one word in the entry name
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const sets = tokens.map((t) => prefixMatchIndices(t));
  sets.sort((a, b) => a.size - b.size);

  const candidates = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    for (const idx of candidates) {
      if (!sets[i].has(idx)) candidates.delete(idx);
    }
  }

  return sortResults([...candidates].map((idx) => entries[idx])).slice(0, limit);
}

// Incrementally adds one entry to every index without a full rebuild — used
// to fold a live BGG search result into the catalog (see
// searchCatalogWithFallback) so the next lookup for the same game is served
// locally. Cheap: only called on an occasional live-search hit, not a hot loop.
export function addCatalogEntry(entry: BGGCatalogEntry): void {
  if (idIndex.has(entry.id)) return;

  const idx = entries.length;
  entries.push(entry);
  idIndex.set(entry.id, entry);

  const key = normalizeName(entry.name);
  if (!exactIndex.has(key)) exactIndex.set(key, []);
  exactIndex.get(key)!.push(entry);

  for (const word of tokenize(entry.name)) {
    if (!wordIndex.has(word)) {
      wordIndex.set(word, [idx]);
      const pos = lowerBound(sortedWords, word);
      sortedWords.splice(pos, 0, word);
    } else {
      wordIndex.get(word)!.push(idx);
    }
  }

  _loaded = true;
}

async function persistDiscoveredEntry(entry: BGGCatalogEntry): Promise<void> {
  const discovered = await readJson<BGGCatalogEntry[]>(DISCOVERED_ENTRIES_FILE, []);
  if (discovered.some((e) => e.id === entry.id)) return;
  discovered.push(entry);
  await writeJson(DISCOVERED_ENTRIES_FILE, discovered);
}

// Falls back to a live BGG search when the local catalog has no match —
// covers new/obscure games added to BGG since the bundled zip was built, or
// simply missed by the fuzzy matcher. A hit is folded into the in-memory
// catalog (and persisted) so future lookups for the same game are served
// locally without hitting BGG again. isExpansion/rank are placeholders here
// (BGG's search endpoint doesn't return them) — callers that resolve full
// game details afterward (e.g. resolveCatalogDetails) already correct these.
export async function searchCatalogWithFallback(query: string, limit = 5): Promise<BGGCatalogEntry[]> {
  const local = searchCatalog(query, limit);
  if (local.length > 0) return local;

  try {
    const live = await searchBGG(query);
    if (live.length === 0) return [];

    const converted: BGGCatalogEntry[] = live.slice(0, limit).map((r) => ({
      id: r.id,
      name: r.name,
      year: r.yearPublished,
      isExpansion: false,
      rank: null,
    }));

    for (const entry of converted) {
      if (!getCatalogEntryById(entry.id)) {
        addCatalogEntry(entry);
        persistDiscoveredEntry(entry).catch((err) =>
          console.warn('[BGGCatalog] Failed to persist discovered entry:', err),
        );
      }
    }

    return converted;
  } catch {
    return [];
  }
}

// For tests only — load catalog from raw CSV text without needing a zip file
export function _loadFromCsvText(csvText: string): void {
  buildIndexes(csvText);
}

export function _resetCatalog(): void {
  entries = [];
  exactIndex = new Map();
  idIndex = new Map();
  wordIndex = new Map();
  sortedWords = [];
  _loaded = false;
}
