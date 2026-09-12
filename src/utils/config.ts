import { readJson, writeJson } from './db';

const FILE = 'config.json';

export interface GuildConfig {
  defaultLocation: string;
  defaultTime: string;
  defaultEndTime: string;
  defaultDescription: string;
  announcementsChannelId: string;
  welcomeChannelId: string;
  // Public "everyone say hi" post when a new member joins — distinct from
  // welcomeChannelId, which is the private walkthrough/introductions embed
  // aimed at the new member themselves. Optional: unset means no public
  // join announcement is posted (see handleGuildMemberAdd in
  // src/events/guildMemberAdd.ts). Set via /admin welcome config.
  memberAnnouncementChannelId: string;
  // Optional GIF/image URL shown as the big image on the public join
  // announcement (see handleGuildMemberAdd) — lets each server pick its own
  // "hello" character/GIF, similar to how other welcome bots show one.
  // Falls back to WELCOME_ANNOUNCEMENT_DEFAULT_GIF_PATH in
  // src/utils/welcomeAnnouncement.ts when unset, if that asset exists.
  memberAnnouncementImageUrl: string;
  rulesChannelId: string;
  // "Quick Actions" button hub for general chat (see updateGeneralHubPin in
  // src/utils/generalHub.ts) — RSVP/Browse/My Games/Random/Request buttons,
  // set via /admin general config. Distinct from welcomeChannelId (new-member
  // greeting) — this is meant for an ongoing, already-populated chat channel.
  generalHubChannelId?: string;
  generalHubPinMessageId?: string;
  facebookGroupUrl: string;
  bggGroupUrl: string;
  openEventChannels: boolean;
  eventCategoryName: string;
  archiveCategoryName: string;
  archivedChannelRetentionDays: number; // 0 = never auto-delete
  // marketplaceChannelId may point at either a Forum channel or a Text channel —
  // both are supported (see postListingToChannel in marketplace.ts), decided by
  // checking the live channel's type rather than a cached mode flag here.
  marketplaceChannelId: string;
  // "Quick Actions" button hub (see updateMarketplaceHubThread in marketplace.ts) —
  // a pinned forum post with Sell/Trade/Browse/My Listings buttons, kept in sync
  // whenever marketplaceChannelId is (re)configured via /admin marketplace config.
  // Forum-mode only — see marketplaceHubMessageId for the Text-channel equivalent.
  marketplaceHubThreadId?: string;
  // Text-channel equivalent of marketplaceHubThreadId — same Quick Actions embed/
  // buttons, but as a plain pinned message rather than a forum thread (see
  // updateMarketplaceHubMessage in marketplace.ts).
  marketplaceHubMessageId?: string;
  // Text-channel-only pinned message listing all active listings grouped by
  // type, substituting for forum tags' status/type filtering (see
  // updateMarketplaceListingIndex in marketplace.ts).
  marketplaceListingIndexMessageId?: string;
  marketplaceNegotiationMode: 'public' | 'private';
  // Forum-mode only — unused when marketplaceChannelId is a Text channel.
  marketplaceTagIds: Record<string, string>;
  gameNightTagIds: Record<string, string>;
  // Lineup lock + scheduler (see src/utils/scheduler.ts). 0 = disabled.
  // Defaults to 48h before the event; set to 0 via /host event config to opt out.
  lockHoursBeforeEvent: number;
  scheduleTableCount: number;
  // Hard ceiling on concurrent tables (e.g. a venue's physical table count) —
  // distinct from scheduleTableCount, which is only ever a floor/default.
  // 0 = uncapped (today's behavior).
  maxTableCount: number;
  // Reserves the LAST N table indices exclusively for Light-complexity games
  // (see isFlexEligible in src/utils/scheduler.ts) — Medium/Heavy and unrated
  // games never use them, even if idle, guaranteeing players who only want
  // quick/light games always have a table available. 0 = disabled.
  flexTableCount: number;
  // Minutes a person needs after one game ends before their next game can
  // start (see src/utils/scheduler.ts's per-person availability tracking),
  // ON TOP OF that game's own complexity buffer (lightBufferMinutes/
  // mediumBufferMinutes/heavyBufferMinutes below, already baked into how
  // long the table itself stays occupied). 0 = no separate break — the
  // complexity buffer alone is the gap between a person's games. Recap
  // validation (see tests/schedulerRecapValidation.test.ts) showed a flat
  // extra 30min on top of the buffer compounds badly for anyone in several
  // games, without changing whether the day fits — the complexity buffer
  // already scales the "padding" to the game itself (a hard rules explanation
  // needs more recovery time than a 10-minute party game), which is a better
  // fit than a flat number applied identically regardless of what was played.
  breakMinutesBetweenGames: number;
  lightBufferMinutes: number;
  mediumBufferMinutes: number;
  heavyBufferMinutes: number;
  // Post a "Log in BG Stats" button per scheduled game when the lineup locks
  // (see src/utils/bgStats.ts). Off by default — opt-in like the rest of the
  // scheduler behavior, since it posts extra messages existing servers didn't ask for.
  postBgStatsLinks: boolean;
  // Post-placement scheduling refinements (see src/utils/scheduler.ts). Unlike most
  // scheduler config these default to non-zero even though the feature itself is
  // opt-in via lockHoursBeforeEvent — once a server turns scheduling on at all,
  // these refinements should be on by default rather than silently inert.
  // Global break inserted before a round when any one table would play two
  // Heavy-complexity games in directly-adjacent rounds. 0 = disabled.
  heavyGameBreakMinutes: number;
  // Cap on total play count for a short game (<30 min raw playtime)
  // opportunistically repeating into leftover round time. Minimum 1 (= no repeats).
  maxGameRepeats: number;
  // /room private channels (see src/commands/room.ts).
  privateRoomCategoryName: string;
  // IANA timezone (e.g. "America/New_York") used to interpret /event
  // date/time input and display it back consistently. Defaults to UTC rather
  // than the host process's local zone, which has no relation to where the
  // community actually is.
  timezone: string;
  // Weekly "Guess the Board Game" challenge (see src/utils/boardGameChallenge.ts).
  // Off by default and requires a channel before it will post — set via
  // /admin challenge config. Hint/reveal timing uses `timezone` above.
  boardGameChallengeEnabled: boolean;
  boardGameChallengeChannelId: string | null;
  // Day-of-week (0=Sunday..6=Saturday, matching nowInTimeZone's `weekday`)
  // and local hour (0-23) for each of the three hints and the reveal.
  // Defaults reproduce the original hardcoded Mon/Wed/Fri 8am + Sat 6pm
  // schedule. Not validated against each other — checkAndAdvanceChallengeSchedule
  // gates purely on hintsPostedCount, so even an admin picking an out-of-order
  // schedule (e.g. clue 2 before clue 1) just degrades to posting both hints
  // on the same day rather than breaking.
  challengeClue1Weekday: number;
  challengeClue1Hour: number;
  challengeClue2Weekday: number;
  challengeClue2Hour: number;
  challengeClue3Weekday: number;
  challengeClue3Hour: number;
  challengeRevealWeekday: number;
  challengeRevealHour: number;
  // How often a new challenge cycle starts (see checkAndAdvanceChallengeSchedule
  // in boardGameChallenge.ts). 'weekly' (default) is the original behavior —
  // one cycle per week, starting Monday. 'daily' runs all 3 hints + the reveal
  // within a single day, using only the *Hour fields above (the *Weekday
  // fields are ignored — there's no "day of week" within a 1-day cycle).
  // 'biweekly' reuses the same weekday-based schedule as 'weekly' but only
  // starts a new cycle every other week, anchored to challengeCycleAnchor.
  challengeFrequency: 'daily' | 'weekly' | 'biweekly';
  // Monday ("YYYY-MM-DD") of the first "on" week for 'biweekly' mode — every
  // 14 days after this date is another on week, the week in between is idle.
  // Ignored for 'daily'/'weekly'. Set via /admin challenge config's
  // `start_date`; defaults to the current week the first time 'biweekly' is
  // turned on without one (see handleChallengeConfig), so it's optional.
  challengeCycleAnchor: string | null;
  // If true, starting a new cycle first deletes the immediately preceding
  // cycle's hint + reveal posts from the channel (best-effort — a missing
  // message or lost Manage Messages permission is logged and skipped, not
  // treated as an error). Off by default: some communities like keeping a
  // scrollback of past answers, so this is opt-in via /admin challenge config.
  challengeCleanupOldPosts: boolean;
  // The pinned "current standings" leaderboard message in the challenge
  // channel (see updateChallengeLeaderboardPin in boardGameChallenge.ts) —
  // edited in place every time someone guesses correctly (not just at the
  // reveal), same pin-tracking pattern as generalHubPinMessageId above.
  challengeLeaderboardPinMessageId?: string;
}

const DEFAULT_CONFIG: GuildConfig = {
  defaultLocation: '',
  defaultTime: '',
  defaultEndTime: '',
  defaultDescription: '',
  announcementsChannelId: '',
  welcomeChannelId: '',
  memberAnnouncementChannelId: '',
  memberAnnouncementImageUrl: '',
  rulesChannelId: '',
  facebookGroupUrl: '',
  bggGroupUrl: '',
  openEventChannels: false,
  eventCategoryName: 'Events',
  archiveCategoryName: 'Archive',
  archivedChannelRetentionDays: 0,
  marketplaceChannelId: '',
  marketplaceNegotiationMode: 'private',
  marketplaceTagIds: {},
  gameNightTagIds: {},
  lockHoursBeforeEvent: 48,
  scheduleTableCount: 1,
  maxTableCount: 0,
  flexTableCount: 0,
  breakMinutesBetweenGames: 0,
  lightBufferMinutes: 15,
  mediumBufferMinutes: 30,
  heavyBufferMinutes: 45,
  postBgStatsLinks: false,
  heavyGameBreakMinutes: 30,
  maxGameRepeats: 3,
  privateRoomCategoryName: 'Private Rooms',
  timezone: 'UTC',
  boardGameChallengeEnabled: false,
  boardGameChallengeChannelId: null,
  challengeClue1Weekday: 1, // Monday
  challengeClue1Hour: 8,
  challengeClue2Weekday: 3, // Wednesday
  challengeClue2Hour: 8,
  challengeClue3Weekday: 5, // Friday
  challengeClue3Hour: 8,
  challengeRevealWeekday: 6, // Saturday
  challengeRevealHour: 18,
  challengeFrequency: 'weekly',
  challengeCycleAnchor: null,
  challengeCleanupOldPosts: false,
};

type ConfigStore = Record<string, GuildConfig>;

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  return (await readJson<ConfigStore>(FILE, {}))[guildId] ?? { ...DEFAULT_CONFIG };
}

// Guild IDs with a persisted config record — i.e. every guild that has ever
// run an /admin config command. Used by scheduled, calendar-driven features
// (e.g. checkAndAdvanceChallengeSchedule in boardGameChallenge.ts) that need
// to sweep every guild rather than react to a single guild's event, since
// there's no per-event record to iterate the way most other periodic checks
// in this codebase (e.g. checkPendingLocks) work off of.
export async function getGuildIdsWithConfig(): Promise<string[]> {
  return Object.keys(await readJson<ConfigStore>(FILE, {}));
}

export async function updateGuildConfig(
  guildId: string,
  patch: Partial<GuildConfig>,
): Promise<GuildConfig> {
  const store = await readJson<ConfigStore>(FILE, {});
  store[guildId] = { ...(await getGuildConfig(guildId)), ...patch };
  await writeJson(FILE, store);
  return store[guildId];
}
