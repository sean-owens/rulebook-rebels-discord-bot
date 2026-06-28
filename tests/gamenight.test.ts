import { describe, it, expect } from 'vitest';
import { parseDateTime } from '../src/commands/gamenight';

const YEAR = new Date().getFullYear();

describe('parseDateTime', () => {
  // ── Time parsing ───────────────────────────────────────────────────────────

  it('parses "7pm" as 19:00', () => {
    const d = parseDateTime('August 22', '7pm');
    expect(d.getHours()).toBe(19);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses "7:30 PM" as 19:30', () => {
    const d = parseDateTime('August 22', '7:30 PM');
    expect(d.getHours()).toBe(19);
    expect(d.getMinutes()).toBe(30);
  });

  it('parses "12pm" as noon (12:00)', () => {
    const d = parseDateTime('August 22', '12pm');
    expect(d.getHours()).toBe(12);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses "12am" as midnight (0:00)', () => {
    const d = parseDateTime('August 22', '12am');
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses "10:00 PM" as 22:00', () => {
    const d = parseDateTime('August 22', '10:00 PM');
    expect(d.getHours()).toBe(22);
    expect(d.getMinutes()).toBe(0);
  });

  // ── Date parsing ───────────────────────────────────────────────────────────

  it('parses full month name', () => {
    const d = parseDateTime('August 22', '7pm');
    expect(d.getMonth()).toBe(7); // 0-indexed
    expect(d.getDate()).toBe(22);
    expect(d.getFullYear()).toBe(YEAR);
  });

  it('parses abbreviated month name', () => {
    const d = parseDateTime('aug 22', '7pm');
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(22);
  });

  it('parses an explicit 4-digit year', () => {
    const d = parseDateTime('September 5 2027', '7pm');
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(5);
  });

  it('handles December correctly', () => {
    const d = parseDateTime('December 31', '11:59 PM');
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(31);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
  });

  it('handles January correctly', () => {
    const d = parseDateTime('January 1', '12am');
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });

  it('ignores extra commas in the date string', () => {
    const d = parseDateTime('August, 22', '7pm');
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(22);
  });

  it('parses ordinal day suffixes (1st, 2nd, 3rd, 30th)', () => {
    expect(parseDateTime('June 30th', '8am').getDate()).toBe(30);
    expect(parseDateTime('July 1st', '7pm').getDate()).toBe(1);
    expect(parseDateTime('August 2nd', '7pm').getDate()).toBe(2);
    expect(parseDateTime('September 3rd', '7pm').getDate()).toBe(3);
  });

  // ── Error cases ────────────────────────────────────────────────────────────

  it('throws when the date string has no recognisable month', () => {
    expect(() => parseDateTime('22nd of the 8th', '7pm')).toThrow();
  });

  it('throws when the date string has no recognisable day', () => {
    expect(() => parseDateTime('August', '7pm')).toThrow();
  });

  it('throws when the time string is not parseable', () => {
    expect(() => parseDateTime('August 22', 'noon')).toThrow();
  });
});
