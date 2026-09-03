// Current wall-clock weekday + hour in `timeZone` — used by scheduled,
// calendar-based features (e.g. the weekly board game challenge, see
// src/utils/boardGameChallenge.ts) to decide "is it time to post yet?"
// against a guild's own local clock rather than the host process's.
export function nowInTimeZone(timeZone: string): { weekday: number; hour: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date())) {
    parts[part.type] = part.value;
  }
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { weekday: weekdays.indexOf(parts.weekday), hour: Number(parts.hour) };
}

// ISO date (YYYY-MM-DD) of the Monday of the current week, as it would read
// on a clock in `timeZone` — used to key one board game challenge per guild
// per week (see createWeeklyChallenge in src/utils/boardGameChallengeStorage.ts).
// Pure calendar-date arithmetic (no timezone conversion needed once we have
// the local Y/M/D) so it's safe to do with a plain UTC-based Date.
export function mondayOfWeekInTimeZone(timeZone: string): string {
  const { weekday } = nowInTimeZone(timeZone);
  const { year, month, day } = todayInTimeZone(timeZone);
  const daysSinceMonday = (weekday + 6) % 7; // Sun(0)->6, Mon(1)->0, ... Sat(6)->5
  const monday = new Date(Date.UTC(year, month, day));
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}

// ISO date (YYYY-MM-DD) of the Monday of the week containing `instant`, as it
// would read on a clock in `timeZone` — the arbitrary-instant counterpart to
// mondayOfWeekInTimeZone (which is always relative to "now"). Used to
// normalize an admin-supplied bi-weekly challenge start date (see /admin
// challenge config's `start_date`, boardgamechallenge.ts) to that week's
// Monday, regardless of which day of the week they actually typed.
export function mondayOfDateInTimeZone(instant: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const daysSinceMonday = (weekdays.indexOf(parts.weekday) + 6) % 7;
  const monday = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}

// Accepts either 24-hour ("20") or 12-hour ("8pm") input for a single hour —
// used by the weekly board game challenge's hint/reveal schedule (see
// /admin challenge config in boardgamechallenge.ts), where hosts commonly
// think in 12-hour time but the stored config (GuildConfig.challengeClue1Hour
// etc.) is always a 0-23 hour. Only whole hours are accepted since that
// schedule has no minute granularity.
export function parseHourInput(raw: string): number {
  const t = raw.trim().toLowerCase().replace(/\s/g, '');
  const isPM = t.endsWith('pm');
  const isAM = t.endsWith('am');
  const numeric = t.replace(/(am|pm)$/, '');
  const colonIdx = numeric.indexOf(':');
  let hours = parseInt(colonIdx === -1 ? numeric : numeric.slice(0, colonIdx), 10);
  const minutes = colonIdx === -1 ? 0 : parseInt(numeric.slice(colonIdx + 1, colonIdx + 3), 10);
  if (isNaN(hours) || isNaN(minutes)) throw new Error(`Invalid hour: "${raw}"`);
  if (minutes !== 0) {
    throw new Error(`Invalid hour: "${raw}" — only whole hours are supported, e.g. "8am" or "20"`);
  }
  // 12-hour input ("8pm") is only ever 1-12; 24-hour input ("20") is 0-23.
  if (isPM || isAM) {
    if (hours < 1 || hours > 12) throw new Error(`Invalid hour: "${raw}"`);
  } else if (hours < 0 || hours > 23) {
    throw new Error(`Invalid hour: "${raw}"`);
  }
  if (isPM && hours !== 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  return hours;
}

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
