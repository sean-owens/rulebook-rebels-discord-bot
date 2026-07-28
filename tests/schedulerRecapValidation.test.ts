import { describe, it, expect } from 'vitest';
import { toSchedulableGame, scheduleGames, buildScheduleEmbed, baseGameId } from '../src/utils/scheduler';
import { GameSuggestion } from '../src/utils/gameStorage';

// Mirrors the bot's real GuildConfig defaults (src/utils/config.ts) — this
// validation is meant to answer "what would OUR bot actually produce," not a
// hand-tuned scenario.
const CONFIG = {
  lightBufferMinutes: 15,
  mediumBufferMinutes: 30,
  heavyBufferMinutes: 45,
  heavyGameBreakMinutes: 30,
  maxGameRepeats: 3,
  breakMinutesBetweenGames: 0,
  flexTableCount: 0,
};

// Only the game titles and actual seated players are real recap ground
// truth (from the revised July 25 monthly event recap,
// d:\Downloads\july-25-monthly-event-recap_1.md, which added two
// previously-missing games — Runner-Up, Madcala). Everything else
// (maxPlaytime, complexity, suggestedPlayers) is real data pulled from the
// BGG XMLAPI2 — the exact same endpoint/parsing logic as src/utils/bgg.ts's
// parseBGGItem — because that's genuinely all the bot has before an event
// happens. The recap's own logged per-instance durations (how long a table
// actually ran) were tried here first, but that's the schedule's *output*,
// not an input available at suggestion time — feeding predicted-vs-actual
// outcome data back in as an input stops this from testing prediction at
// all, it just replays history. maxPlaytime is BGG's `maxplaytime` box
// figure; complexity is BGG's `averageweight` run through the bot's own
// weightTag() tiering (Light ≤2.0, Medium ≤3.5, Heavy >3.5); suggestedPlayers
// is the `suggested_numplayers` poll's "Best" vote winner — for each game's
// real BGG id (Harmonies 414317, Castles of Burgundy 84876, Deep Rock
// Galactic: The Board Game 348220, Anachrony 185343, Let's Go! To Japan
// 368173, Ticket to Ride 9209, Cross Clues 300753, The Game Makers 447776,
// Cabo 73664, Panda Panda 400113, Mountain Goats 63975, Euphoria: Build a
// Better Dystopia 133848, Luthier 371330, Tír na nÓg 343433, Firefly: The
// Game 138161, Madcala 414764). Trickster and Magical Athletes have no BGG
// search match precise enough to trust (search returns unrelated
// promo/expansion items) — their complexity/maxPlaytime/suggestedPlayers
// stay as best-effort placeholders (suggestedPlayers from the recap
// document's own commentary, "best at 4 players" / "best with 5-6 players").
// Unrated/no-BGG-listing games (Marigold, Sunk Cost, Runner-Up) keep a
// manually-estimated maxPlaytime, exactly like a host entering a custom
// game the bot can't look up.
// Deep Rock Galactic was originally modeled as 3 separate suggestions
// (Deep Rock / "again" / "3rd time"), one per real play logged in the
// recap — but that's an artifact of reconstructing a static snapshot from
// retrospective history, not how the real signup flow ever produces data:
// in production, a second wave of interest in an already-suggested game
// joins that SAME suggestion's waitlist, it doesn't create a new one.
// Consolidated into the one suggestion a real pre-event signup list would
// actually have: every real person who played Deep Rock Galactic that day
// (Sebastian, Erika, Will, Larry, Tina — 5 people) on a single suggestion.
// Its real BGG maxPlayers is 4 (id 348220), so seats are capped there and
// the 5th person is modeled on the waitlist — exactly the group-splitting
// scenario (src/utils/scheduler.ts's expandGamesIntoGroups), and unlike
// Magical Athletes below, this one needs no fictional data to trigger it.
// Magical Athletes also carries a waitlist (see comment at its entry below)
// — not real recap data, but a deliberate addition to validate
// group-splitting against this same real, densely-connected event, the same
// way this file already validates multi-pass and quorum against it.
const RECAP_GAMES: Array<{ title: string; complexity?: string; maxPlaytime: number; seats: string[]; suggestedPlayers?: number; waitlist?: string[]; maxPlayers?: number }> = [
  { title: 'Harmonies', complexity: 'Medium', maxPlaytime: 45, seats: ['Theresa', 'Nora', 'Christine', 'Zach'], suggestedPlayers: 2 },
  { title: 'Castles of Burgundy', complexity: 'Medium', maxPlaytime: 90, seats: ['Sonja', 'Jase', 'Cindy'], suggestedPlayers: 2 },
  { title: 'Deep Rock', complexity: 'Medium', maxPlaytime: 150, seats: ['Sebastian', 'Erika', 'Will', 'Larry'], waitlist: ['Tina'], suggestedPlayers: 4, maxPlayers: 4 },
  { title: 'Anachrony', complexity: 'Heavy', maxPlaytime: 120, seats: ['Bradley', 'Larry', 'Bobby', "Bobby's Brother"], suggestedPlayers: 3 },
  { title: "Let's Go to Japan", complexity: 'Medium', maxPlaytime: 60, seats: ['Steven', 'Belanna', 'Simon', 'Alisa', 'Vlad'], suggestedPlayers: 3 },
  { title: 'Ticket to Ride', complexity: 'Light', maxPlaytime: 60, seats: ['Earl', 'Nelda', 'Scott'], suggestedPlayers: 4 },
  // BGG box time is a real 10 min — the "several quick rounds back-to-back"
  // behavior the recap described isn't hardcoded here at all; it's exactly
  // what the scheduler's own opportunistic repeat-fill is for (raw playtime
  // under 30 min), so it should emerge on its own if the schedule has room.
  { title: 'Cross Clues', complexity: 'Light', maxPlaytime: 10, seats: ['Jess', 'Nora', 'Zach', 'Simon', 'Belanna'], suggestedPlayers: 4 },
  // No confident BGG match — complexity/maxPlaytime/suggestedPlayers are
  // best-effort placeholders, not verified BGG data. See comment above.
  { title: 'Trickster', complexity: 'Light', maxPlaytime: 74, seats: ['Steven', 'Alisa', 'Vlad', 'Jordan', 'Theresa', 'Christine', 'Tom'], suggestedPlayers: 4 },
  { title: 'Game Makers', complexity: 'Medium', maxPlaytime: 90, seats: ['Scott', 'Tina', 'David'], suggestedPlayers: 2 },
  // Unrated (no BGG listing per the recap) — modeled with a manually
  // estimated duration, same as a manually-entered custom game would be.
  { title: 'Marigold', maxPlaytime: 60, seats: ['Jess', 'Will', 'Zach', 'Sean', 'Simon'] },
  { title: 'Cabo', complexity: 'Light', maxPlaytime: 30, seats: ['Sonja', 'Cindy', 'Nora'], suggestedPlayers: 4 },
  { title: 'Panda Panda', complexity: 'Light', maxPlaytime: 15, seats: ['Sonja', 'Steven', 'Cindy', 'Nora'], suggestedPlayers: 4 },
  { title: 'Mountain Goats', complexity: 'Light', maxPlaytime: 20, seats: ['Jess', 'Nora', 'Cindy', 'Will', 'Sonja'], suggestedPlayers: 4 },
  { title: 'Euphoria', complexity: 'Medium', maxPlaytime: 60, seats: ['Bobby', "Bobby's Brother", 'Jase', 'Steven'], suggestedPlayers: 4 },
  { title: 'Luthier', complexity: 'Heavy', maxPlaytime: 150, seats: ['Theresa', 'Scott', 'Jordan', 'Belanna'], suggestedPlayers: 3 },
  { title: 'Tir Na Nog', complexity: 'Medium', maxPlaytime: 45, seats: ['Jess', 'Sonja', 'Simon', 'Larry', 'Sean'], suggestedPlayers: 3 },
  // Real event context (see conversation): Firefly drew almost no interest
  // before the event — just 1 signup — and only grew to a 4-person table via
  // walk-up interest during the day. Modeled with its real PRE-EVENT signup
  // count, which is exactly the ad-hoc/low-interest scenario this session's
  // scheduler rework was built to handle (not the recap's reconstructed
  // after-the-fact 4-person attendance starting 3:45 PM).
  { title: 'Firefly', complexity: 'Medium', maxPlaytime: 240, seats: ['Bradley'], suggestedPlayers: 3 },
  { title: 'Sunk Cost', maxPlaytime: 35, seats: ['Simon', 'Jase'] }, // unrated, no BGG listing
  // No confident BGG match — see comment above. Waitlist is not real recap
  // data — added to validate group-splitting (see the note above
  // RECAP_GAMES): 6 seated + 2 waitlisted exceeds this game's maxPlayers (6),
  // so it should split into two groups of 4, both real, densely-entangled
  // players (Nora and Zach are each seated in several other games today).
  { title: 'Magical Athletes', complexity: 'Light', maxPlaytime: 45, seats: ['Jess', 'Steven', 'Tina', 'Christine', 'Larry', 'Simon'], suggestedPlayers: 5, waitlist: ['Nora', 'Zach'] },
  // New in the revised recap — missing from the original data pull.
  { title: 'Runner-Up', maxPlaytime: 25, seats: ['Tom', 'Jordan', 'Jess'] }, // unrated, no BGG listing
  { title: 'Madcala', complexity: 'Light', maxPlaytime: 30, seats: ['Scott', 'Jess'], suggestedPlayers: 2 },
];

function toGameSuggestion(data: (typeof RECAP_GAMES)[number], index: number): GameSuggestion {
  return {
    id: `recap-game-${index}`,
    title: data.title,
    minPlayers: 2,
    maxPlayers: data.maxPlayers ?? Math.max(data.seats.length, 6),
    suggestedPlayers: data.suggestedPlayers ?? null,
    maxPlaytime: data.maxPlaytime,
    complexity: data.complexity,
    seats: data.seats,
    waitlist: data.waitlist ?? [],
  } as GameSuggestion;
}

describe('scheduler validation against the July 25 monthly event recap', () => {
  it('produces a sane, non-overlapping 11am-8pm schedule for the real recap game list/signups', () => {
    const suggestions = RECAP_GAMES.map((g, i) => toGameSuggestion(g, i));
    const schedulable = suggestions.map((g) => toSchedulableGame(g, CONFIG));

    const TABLE_COUNT = 6; // the real venue's actual table cap
    const WINDOW_MINUTES = 9 * 60; // 11:00 AM - 8:00 PM

    const result = scheduleGames(schedulable, TABLE_COUNT, WINDOW_MINUTES, CONFIG);
    const games = result.resolvedGames;

    // --- Print a human-readable itinerary for manual review ---
    const gn = { title: 'July 25 Monthly Event (recap replay)', startTimeISO: '2026-07-25T11:00:00.000Z' };
    const embed = buildScheduleEmbed(gn as any, games, result);
    const data = embed.toJSON();

    console.log('\n=== Simulated schedule: 11:00 AM - 8:00 PM, 6 tables ===\n');
    for (const field of data.fields ?? []) {
      console.log(`--- ${field.name} ---`);
      console.log(field.value);
      console.log('');
    }
    console.log(`Footer: ${data.footer?.text}\n`);

    // --- Per-person "first activity" audit (who's idle at 11:00 AM, and until when) ---
    function clockOf(minutes: number): string {
      const totalMin = 11 * 60 + minutes;
      let h = Math.floor(totalMin / 60) % 24;
      const m = Math.round(totalMin % 60);
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
    }
    const allPlayers = new Set<string>();
    for (const g of games) for (const p of g.seatedPlayers) allPlayers.add(p);
    const firstNonLowInterestByPlayer = new Map<string, { title: string; start: number }>();
    for (const a of result.assignments) {
      const game = games.find((g) => g.id === a.gameId)!;
      for (const p of game.seatedPlayers) {
        const existing = firstNonLowInterestByPlayer.get(p);
        if (!existing || a.startMinutes < existing.start) {
          firstNonLowInterestByPlayer.set(p, { title: game.title, start: a.startMinutes });
        }
      }
    }
    const audit = [...allPlayers].map((p) => {
      const first = firstNonLowInterestByPlayer.get(p);
      return { player: p, firstGame: first?.title ?? '(low-interest only)', startsAt: first ? clockOf(first.start) : 'n/a', idleMinutes: first?.start ?? 0 };
    }).sort((a, b) => b.idleMinutes - a.idleMinutes);
    console.log('=== PER-PERSON FIRST ACTIVITY (sorted by longest idle-at-start) ===');
    console.log(JSON.stringify(audit, null, 2));

    // --- Plain-text version (no Discord markup) for building a shareable doc ---
    function clock(minutes: number): string {
      const totalMin = 11 * 60 + minutes; // event starts at 11:00 AM
      let h = Math.floor(totalMin / 60) % 24;
      const m = Math.round(totalMin % 60);
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
    }
    console.log('=== PLAIN TEXT ===');
    console.log(JSON.stringify({
      tables: shownTablesPlain(result, games),
      walkUps: result.walkUps.map((w) => ({
        title: games.find((g) => g.id === w.gameId)?.title,
        players: games.find((g) => g.id === w.gameId)?.seatedPlayers,
      })),
      unscheduled: result.unscheduled.map((u) => ({
        title: games.find((g) => g.id === u.gameId)?.title,
        reason: u.reason,
      })),
      playerWarnings: result.playerWarnings,
      footer: data.footer?.text,
    }, null, 2));

    function shownTablesPlain(r: typeof result, gs: typeof games) {
      const byT = new Map<number, typeof r.assignments>();
      for (const a of r.assignments) {
        const arr = byT.get(a.table) ?? [];
        arr.push(a);
        byT.set(a.table, arr);
      }
      return [...byT.entries()].sort(([a], [b]) => a - b).map(([table, slots]) => ({
        table,
        games: [...slots].sort((x, y) => x.startMinutes - y.startMinutes).map((a) => ({
          title: gs.find((g) => g.id === a.gameId)?.title,
          complexity: schedulable.find((s) => s.id === a.gameId)?.complexity ?? null,
          players: gs.find((g) => g.id === a.gameId)?.seatedPlayers,
          start: clock(a.startMinutes),
          end: clock(a.endMinutes),
          startMinutes: a.startMinutes,
          endMinutes: a.endMinutes,
          mayNotFinish: a.mayNotFinish,
          waitingOn: a.delayedByPlayerId ?? null,
          playCount: a.playCount,
        })),
      }));
    }

    // --- Sanity checks (not just a print statement) ---

    // Nobody is double-booked: no two of a player's assigned games overlap in
    // time. Only the quorum-selected attendingPlayerIds are actually occupied
    // by a given assignment — anyone signed up but left out of quorum (see
    // quorumThreshold) stays free for another game at the same time, same as
    // buildScheduleEmbed treats it.
    const byPlayer = new Map<string, Array<{ start: number; end: number }>>();
    for (const a of result.assignments) {
      for (const p of a.attendingPlayerIds) {
        const intervals = byPlayer.get(p) ?? [];
        for (const iv of intervals) {
          expect(a.startMinutes < iv.end && iv.start < a.endMinutes).toBe(false);
        }
        intervals.push({ start: a.startMinutes, end: a.endMinutes });
        byPlayer.set(p, intervals);
      }
    }

    // Every suggested game either got at least one table session, a walk-up
    // slot, or a clear "not scheduled" reason. A split game (see
    // expandGamesIntoGroups) contributes multiple assignments for the same
    // real suggestion, so count distinct real games, not raw assignment rows.
    const realGameIdsCovered = new Set([
      ...result.assignments.map((a) => baseGameId(a.gameId)),
      ...result.walkUps.map((w) => w.gameId),
      ...result.unscheduled.map((u) => u.gameId),
    ]);
    expect(realGameIdsCovered.size).toBe(RECAP_GAMES.length);

    // Firefly (1 real pre-event signup) is a walk-up opportunity, not
    // excluded and not competing for a real table slot — the exact scenario
    // the ad-hoc scheduling change targets.
    const fireflyId = suggestions.find((g) => g.title === 'Firefly')!.id;
    expect(result.walkUps.some((w) => w.gameId === fireflyId)).toBe(true);
    expect(result.assignments.some((a) => a.gameId === fireflyId)).toBe(false);
  });
});
