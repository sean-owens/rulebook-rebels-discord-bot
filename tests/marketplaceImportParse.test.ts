import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseCsv,
  parseCondition,
  parseImportCsv,
  matchImportItem,
  IMPORT_TEMPLATE_CSV,
  MAX_IMPORT_ROWS,
} from '../src/utils/marketplaceImport';
import { _loadFromCsvText, _resetCatalog } from '../src/utils/bggCatalog';

const HEADER = 'type,item,condition,price,offers_allowed,looking_for,notes,bgg_id';

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, embedded newlines and CRLF', () => {
    const rows = parseCsv('a,"b, c","say ""hi""","line1\nline2"\r\nx,y,z,w\r\n');
    expect(rows).toEqual([
      ['a', 'b, c', 'say "hi"', 'line1\nline2'],
      ['x', 'y', 'z', 'w'],
    ]);
  });

  it('drops a leading BOM and keeps a final record with no trailing newline', () => {
    expect(parseCsv('﻿a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseCondition', () => {
  it.each([
    ['new', 'new'],
    ['Like New', 'like_new'],
    ['very-good', 'very_good'],
    ['GOOD', 'good'],
    ['acceptable', 'acceptable'],
  ])('accepts %s', (raw, expected) => expect(parseCondition(raw)).toBe(expected));

  it('rejects unknown grades', () => {
    expect(parseCondition('mint')).toBeUndefined();
    expect(parseCondition('')).toBeUndefined();
  });
});

describe('parseImportCsv', () => {
  it('parses the bundled template with no errors', () => {
    const result = parseImportCsv(IMPORT_TEMPLATE_CSV);
    expect(result.fatal).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.type, r.item])).toEqual([
      ['sell', 'Wingspan'],
      ['sell', 'Ark Nova'],
      ['trade', 'Catan'],
    ]);
  });

  it('reads sell fields: price with $ and commas, blank offers_allowed defaults to yes', () => {
    const { rows } = parseImportCsv(`${HEADER}\nsell,Wingspan,good,"$1,250.50",,,,`);
    expect(rows[0]).toMatchObject({ type: 'sell', price: 1250.5, bidsAllowed: true });
  });

  it('treats blank type as sell and a missing type column as sell', () => {
    const { rows } = parseImportCsv('item,condition\nWingspan,new');
    expect(rows[0]).toMatchObject({ type: 'sell', item: 'Wingspan', condition: 'new' });
    expect(rows[0].price).toBeUndefined();
  });

  it('reads trade rows, forcing offers on and ignoring price', () => {
    const { rows } = parseImportCsv(`${HEADER}\ntrade,Catan,good,99,no,Wingspan,Worn box,`);
    expect(rows[0]).toMatchObject({
      type: 'trade',
      bidsAllowed: true,
      lookingFor: 'Wingspan',
      notes: 'Worn box',
    });
    expect(rows[0].price).toBeUndefined();
  });

  it('matches header names case-insensitively and ignores unknown columns', () => {
    const { rows, errors } = parseImportCsv('ITEM, Condition ,extra\nWingspan,new,whatever');
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('reports per-row errors with the file line number and keeps good rows', () => {
    const csv = [
      HEADER,
      'sell,Wingspan,good,30,yes,,,',
      'sell,,good,30,yes,,,',
      'sell,Catan,mint,30,yes,,,',
      'swap,Azul,good,,,,,',
      'sell,Azul,good,abc,yes,,,',
      'sell,Azul,good,,maybe,,,',
      'sell,Azul,good,,no,,,',
      'sell,Azul,good,10,yes,,,12x',
    ].join('\n');
    const { rows, errors } = parseImportCsv(csv);
    expect(rows.map((r) => r.item)).toEqual(['Wingspan']);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(errors[0].message).toContain('item is required');
    expect(errors[1].message).toContain('condition');
    expect(errors[2].message).toContain('type');
    expect(errors[3].message).toContain('price');
    expect(errors[4].message).toContain('offers_allowed');
    expect(errors[5].message).toContain('firm-price');
    expect(errors[6].message).toContain('bgg_id');
  });

  it('skips blank lines without counting them as rows or errors', () => {
    const { rows, errors } = parseImportCsv(`${HEADER}\n\nsell,Wingspan,good,,,,,\n,,,,,,,\n`);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('is fatal for an empty file, a missing required column, a header-only file, or too many rows', () => {
    expect(parseImportCsv('').fatal).toContain('empty');
    expect(parseImportCsv('item,price\nWingspan,3').fatal).toContain('`condition`');
    expect(parseImportCsv(HEADER).fatal).toContain('no item rows');
    const many = [HEADER, ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `sell,Game ${i},good,,,,,`)].join('\n');
    expect(parseImportCsv(many).fatal).toContain('Too many rows');
  });

  it('accepts exactly the row limit', () => {
    const rows = [HEADER, ...Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `sell,Game ${i},good,,,,,`)].join('\n');
    expect(parseImportCsv(rows).fatal).toBeUndefined();
  });

  it('rejects over-long notes and item names', () => {
    const { errors } = parseImportCsv(`${HEADER}\nsell,${'x'.repeat(151)},good,,,,,\nsell,Azul,good,,,,${'n'.repeat(501)},`);
    expect(errors.map((e) => e.line)).toEqual([2, 3]);
  });
});

describe('matchImportItem', () => {
  const CATALOG = `id,name,yearpublished,rank,bayesaverage,average,usersrated,is_expansion,abstracts_rank
266192,Wingspan,2019,5,8.01,8.10,80000,0,
174430,Gloomhaven,2017,4,8.29,8.53,67317,0,
`;

  beforeEach(() => {
    _resetCatalog();
    _loadFromCsvText(CATALOG);
  });
  afterEach(() => _resetCatalog());

  it('reports an exact match (case/punctuation-insensitive)', () => {
    expect(matchImportItem({ item: 'WINGSPAN' })).toMatchObject({ quality: 'exact', bggId: '266192', matchedName: 'Wingspan' });
  });

  it('flags a partial-name hit as a guess', () => {
    expect(matchImportItem({ item: 'Gloom' })).toMatchObject({ quality: 'guess', bggId: '174430' });
  });

  it('reports no match for an unknown item', () => {
    expect(matchImportItem({ item: 'Totally Made Up Game' })).toEqual({ quality: 'none' });
  });

  it('lets an explicit bgg_id win over the name, and flags an unknown id', () => {
    expect(matchImportItem({ item: 'Some other name', bggId: '174430' })).toMatchObject({ quality: 'exact', matchedName: 'Gloomhaven' });
    expect(matchImportItem({ item: 'Wingspan', bggId: '999999' })).toEqual({ quality: 'bad_id' });
  });
});
