export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Today's calendar date as it would read on a clock in `timeZone` — used to
// decide whether a year-less date ("August 22") should roll forward to next
// year, without getting the "is this the past" answer wrong for a community
// on the other side of a midnight boundary from UTC or the host process.
export function todayInTimeZone(timeZone: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date())) {
    parts[part.type] = part.value;
  }
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}

// Converts a wall-clock date/time as it would read on a clock in `timeZone`
// into the corresponding absolute instant (UTC). `month` is 0-indexed, matching
// the native `Date` constructor. This is what lets us store one correct
// `startTimeISO`/`endTimeISO` regardless of which zone the community is in,
// instead of relying on the host process's own local timezone (which on a
// cloud host has nothing to do with where the server's members actually are).
//
// Uses a single-correction pass via Intl.DateTimeFormat rather than a date
// library. This is exact except for the rare wall-clock times that fall
// inside a DST transition gap/overlap themselves (at most a couple of hours,
// twice a year, per zone) — an acceptable approximation for scheduling a game
// night.
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timeZone: string,
): Date {
  const asUTC = Date.UTC(year, month, day, hours, minutes, 0, 0);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(asUTC))) {
    parts[part.type] = part.value;
  }

  const asIfLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return new Date(asUTC + (asUTC - asIfLocal));
}
