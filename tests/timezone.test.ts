import { describe, it, expect } from 'vitest';
import { isValidTimeZone, zonedTimeToUtc } from '../src/utils/timezone';

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
