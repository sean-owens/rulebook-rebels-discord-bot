import { describe, it, expect } from 'vitest';
import { isValidTimeZone, zonedTimeToUtc, parseHourInput, mondayOfDateInTimeZone } from '../src/utils/timezone';

describe('parseHourInput', () => {
  it('accepts 24-hour input', () => {
    expect(parseHourInput('0')).toBe(0);
    expect(parseHourInput('9')).toBe(9);
    expect(parseHourInput('20')).toBe(20);
    expect(parseHourInput('23')).toBe(23);
  });

  it('accepts 12-hour input, case-insensitively and with a space before am/pm', () => {
    expect(parseHourInput('12am')).toBe(0);
    expect(parseHourInput('8AM')).toBe(8);
    expect(parseHourInput('8 am')).toBe(8);
    expect(parseHourInput('12pm')).toBe(12);
    expect(parseHourInput('8pm')).toBe(20);
  });

  it('rejects out-of-range hours for each format', () => {
    expect(() => parseHourInput('24')).toThrow();
    expect(() => parseHourInput('-1')).toThrow();
    expect(() => parseHourInput('13pm')).toThrow();
    expect(() => parseHourInput('0am')).toThrow();
  });

  it('rejects non-zero minutes since the schedule has no minute granularity', () => {
    expect(() => parseHourInput('8:30am')).toThrow();
    expect(() => parseHourInput('20:15')).toThrow();
  });

  it('accepts an explicit :00', () => {
    expect(parseHourInput('8:00am')).toBe(8);
    expect(parseHourInput('20:00')).toBe(20);
  });

  it('rejects garbage input', () => {
    expect(() => parseHourInput('not-a-time')).toThrow();
    expect(() => parseHourInput('')).toThrow();
  });
});

describe('isValidTimeZone', () => {
  it('accepts a valid IANA timezone name', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Australia/Sydney')).toBe(true);
  });

  it('rejects garbage input', () => {
    expect(isValidTimeZone('Not/A_Zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('zonedTimeToUtc', () => {
  it('treats UTC as a no-op conversion', () => {
    const d = zonedTimeToUtc(2026, 7, 22, 19, 0, 'UTC');
    expect(d.toISOString()).toBe('2026-08-22T19:00:00.000Z');
  });

  it('converts a summer (DST) wall-clock time in America/New_York to the correct UTC instant', () => {
    // 7:00 PM EDT (UTC-4) in July.
    const d = zonedTimeToUtc(2026, 6, 14, 19, 0, 'America/New_York');
    expect(d.toISOString()).toBe('2026-07-14T23:00:00.000Z');
  });

  it('converts a winter (standard time) wall-clock time in America/New_York to the correct UTC instant', () => {
    // 7:00 PM EST (UTC-5) in January.
    const d = zonedTimeToUtc(2026, 0, 14, 19, 0, 'America/New_York');
    expect(d.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('converts a wall-clock time in a zone ahead of UTC correctly', () => {
    // 9:00 AM AEDT (UTC+11) in January (Southern Hemisphere summer).
    const d = zonedTimeToUtc(2026, 0, 15, 9, 0, 'Australia/Sydney');
    expect(d.toISOString()).toBe('2026-01-14T22:00:00.000Z');
  });
});

describe('mondayOfDateInTimeZone', () => {
  it('returns the same date when given a Monday', () => {
    // 2026-08-24 is a Monday.
    expect(mondayOfDateInTimeZone(new Date('2026-08-24T12:00:00Z'), 'UTC')).toBe('2026-08-24');
  });

  it('rolls a mid-week date back to that week\'s Monday', () => {
    // 2026-08-27 is a Thursday.
    expect(mondayOfDateInTimeZone(new Date('2026-08-27T12:00:00Z'), 'UTC')).toBe('2026-08-24');
  });

  it('rolls a Sunday back to that (ending) week\'s Monday, not the next one', () => {
    // 2026-08-30 is a Sunday, still part of the Aug 24 week.
    expect(mondayOfDateInTimeZone(new Date('2026-08-30T12:00:00Z'), 'UTC')).toBe('2026-08-24');
  });

  it('resolves against the given timezone, not UTC', () => {
    // 2026-08-24T02:00:00Z is still Sunday Aug 23 in America/New_York (UTC-4
    // in August) — should roll back to the *previous* week's Monday there,
    // even though the instant reads as Monday in UTC.
    expect(mondayOfDateInTimeZone(new Date('2026-08-24T02:00:00Z'), 'America/New_York')).toBe('2026-08-17');
  });
});
