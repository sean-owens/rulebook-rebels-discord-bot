import { readJson, writeJson } from './db';

const FILE = 'config.json';

export interface GuildConfig {
  defaultLocation: string;
  defaultTime: string;
  defaultEndTime: string;
  defaultDescription: string;
  announcementsChannelId: string;
  welcomeChannelId: string;
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
}

const DEFAULT_CONFIG: GuildConfig = {
  defaultLocation: '',
  defaultTime: '',
  defaultEndTime: '',
  defaultDescription: '',
  announcementsChannelId: '',
  welcomeChannelId: '',
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
};

type ConfigStore = Record<string, GuildConfig>;

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  return (await readJson<ConfigStore>(FILE, {}))[guildId] ?? { ...DEFAULT_CONFIG };
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
