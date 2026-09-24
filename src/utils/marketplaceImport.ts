import { Condition, CONDITION_LABELS } from './marketplaceStorage';
import { searchCatalog, getCatalogEntryById, normalizeName } from './bggCatalog';

export const MAX_IMPORT_ROWS = 25;
export const MAX_IMPORT_BYTES = 100 * 1024;
const MAX_ITEM_LENGTH = 150;
const MAX_NOTES_LENGTH = 500;
const MAX_LOOKING_FOR_LENGTH = 200;
const MAX_PRICE = 100000;

export const IMPORT_COLUMNS = ['type', 'item', 'condition', 'price', 'offers_allowed', 'looking_for', 'notes', 'bgg_id'] as const;

// Sample file handed out by /marketplace template — one sell row (with a
// price), one firm-price sell row, one trade row, so every column's expected
// shape is shown by example.
export const IMPORT_TEMPLATE_CSV = [
  IMPORT_COLUMNS.join(','),
  'sell,Wingspan,like_new,30.00,yes,,Played twice,',
  'sell,Ark Nova,new,45,no,,Still in shrink,',
  'trade,Catan,good,,,Wingspan or Ark Nova,Missing one road piece,',
  '',
].join('\n');

export interface ParsedImportRow {
  line: number; // 1-based line in the file (header is line 1) for error messages
  type: 'sell' | 'trade';
  item: string;
  condition: Condition;
  price?: number;
  bidsAllowed: boolean;
  lookingFor?: string;
  notes?: string;
  bggId?: string;
}

export interface ImportRowError {
  line: number;
  message: string;
}

export interface ImportParseResult {
  rows: ParsedImportRow[];
  errors: ImportRowError[];
  // Set when the file as a whole is unusable (bad header, empty, too many rows)
  // — no per-row results are meaningful in that case.
  fatal?: string;
}

// Minimal RFC 4180 parser: quoted fields may contain commas, newlines and
// doubled quotes. Returns one string[] per record; a leading BOM is dropped.
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

export function parseCondition(raw: string): Condition | undefined {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (Object.keys(CONDITION_LABELS) as Condition[]).find((c) => c === key);
}

function parseYesNo(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(v)) return true;
  if (['no', 'n', 'false', '0'].includes(v)) return false;
  return undefined;
}

export function parseImportCsv(text: string): ImportParseResult {
  const records = parseCsv(text).filter((r) => r.some((f) => f.trim() !== ''));
  if (records.length === 0) return { rows: [], errors: [], fatal: 'The file is empty.' };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const missing = ['item', 'condition'].filter((c) => col(c) === -1);
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [],
      fatal: `The header row is missing required column(s): ${missing.map((m) => `\`${m}\``).join(', ')}. Run \`/marketplace template\` for a correct starting file.`,
    };
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) return { rows: [], errors: [], fatal: 'The file has a header but no item rows.' };
  if (dataRecords.length > MAX_IMPORT_ROWS) {
    return {
      rows: [],
      errors: [],
      fatal: `Too many rows (${dataRecords.length}) — the limit is ${MAX_IMPORT_ROWS} per import. Split the file and import it in batches.`,
    };
  }

  const cell = (record: string[], name: string): string => (col(name) === -1 ? '' : (record[col(name)] ?? '').trim());
  const rows: ParsedImportRow[] = [];
  const errors: ImportRowError[] = [];

  dataRecords.forEach((record, idx) => {
    const line = idx + 2;
    const fail = (message: string) => errors.push({ line, message });

    const typeRaw = cell(record, 'type').toLowerCase();
    if (typeRaw && typeRaw !== 'sell' && typeRaw !== 'trade') return fail(`type "${typeRaw}" must be \`sell\` or \`trade\` (or blank for sell).`);
    const type = typeRaw === 'trade' ? 'trade' : 'sell';

    const item = cell(record, 'item');
    if (!item) return fail('item is required.');
    if (item.length > MAX_ITEM_LENGTH) return fail(`item is too long (max ${MAX_ITEM_LENGTH} characters).`);

    const condition = parseCondition(cell(record, 'condition'));
    if (!condition) {
      return fail(`condition "${cell(record, 'condition')}" isn't valid — use new, like_new, very_good, good, or acceptable.`);
    }

    const notes = cell(record, 'notes') || undefined;
    if (notes && notes.length > MAX_NOTES_LENGTH) return fail(`notes are too long (max ${MAX_NOTES_LENGTH} characters).`);

    const bggIdRaw = cell(record, 'bgg_id');
    if (bggIdRaw && !/^\d+$/.test(bggIdRaw)) return fail(`bgg_id "${bggIdRaw}" must be a number.`);

    if (type === 'trade') {
      const lookingFor = cell(record, 'looking_for') || undefined;
      if (lookingFor && lookingFor.length > MAX_LOOKING_FOR_LENGTH) {
        return fail(`looking_for is too long (max ${MAX_LOOKING_FOR_LENGTH} characters).`);
      }
      rows.push({ line, type, item, condition, bidsAllowed: true, lookingFor, notes, bggId: bggIdRaw || undefined });
      return;
    }

    const priceRaw = cell(record, 'price');
    let price: number | undefined;
    if (priceRaw) {
      price = parseFloat(priceRaw.replace(/[$,\s]/g, ''));
      if (isNaN(price) || price < 0 || price > MAX_PRICE) return fail(`price "${priceRaw}" isn't a valid amount (like 25 or 25.00).`);
    }

    const offersRaw = cell(record, 'offers_allowed');
    const offers = offersRaw ? parseYesNo(offersRaw) : true;
    if (offers === undefined) return fail(`offers_allowed "${offersRaw}" must be yes or no (or blank for yes).`);
    if (!offers && price === undefined) return fail('a firm-price listing (offers_allowed = no) needs a price.');

    rows.push({ line, type, item, condition, price, bidsAllowed: offers, notes, bggId: bggIdRaw || undefined });
  });

  return { rows, errors };
}

export type ImportMatchQuality = 'exact' | 'guess' | 'none' | 'bad_id';

export interface ImportMatch {
  quality: ImportMatchQuality;
  bggId?: string;
  matchedName?: string;
  matchedYear?: number | null;
}

// Local-catalog-only match (no live BGG calls — see CLAUDE.md §4). An explicit
// bgg_id always wins; otherwise it's the same top-hit guess a free-typed
// /marketplace post uses, reported as 'exact' only when the names normalize
// identically, so the preview can flag the rest for a human to check.
export function matchImportItem(row: Pick<ParsedImportRow, 'item' | 'bggId'>): ImportMatch {
  if (row.bggId) {
    const entry = getCatalogEntryById(row.bggId);
    return entry
      ? { quality: 'exact', bggId: entry.id, matchedName: entry.name, matchedYear: entry.year }
      : { quality: 'bad_id' };
  }
  const [entry] = searchCatalog(row.item, 1);
  if (!entry) return { quality: 'none' };
  const exact = normalizeName(entry.name) === normalizeName(row.item);
  return { quality: exact ? 'exact' : 'guess', bggId: entry.id, matchedName: entry.name, matchedYear: entry.year };
}
