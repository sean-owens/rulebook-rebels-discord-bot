import { readJson, writeJson } from './db';

const FILE = 'gamenights.json';

export interface GameNight {
  id: string;
  // Optional because events created before this field existed won't have it —
  // display code should fall back to something like "Game Night".
  title?: string;
  date: string;
  time: string;
  location: string;
  link: string;
  description: string;
  messageId: string;
  channelId: string;
  guildId: string;
  discordEventId: string | null;
  eventChannelId: string | null;
  startTimeISO: string;
  endTimeISO: string | null;
  rsvps: {
    yes: string[];
    maybe: string[];
    no: string[];
  };
  createdBy: string;
  cancelled: boolean;
  archived: boolean;
  locked?: boolean;
  lockAt?: string;
  channelDeleted?: boolean;
  createdAt: string;
  requestPinMessageId?: string;
  gameListPinMessageId?: string;
  // "Quick Actions" button hub (see src/utils/requestPin.ts's updateHubPin) —
  // Suggest a Game / Request a Game to Bring / My Games to Bring buttons,
  // posted once at event-channel creation for members who'd rather tap a
  // button than type a slash command.
  hubPinMessageId?: string;
  openChannel?: boolean;
  // Lineup lock + scheduler (see src/utils/scheduler.ts).
  suggestionsLocked?: boolean;
  scheduledAt?: string;
  // Greeter role (see src/utils/greeters.ts) — up to 2 user IDs, set via
  // `/host event greeters` and rotated by the host each event.
  greeters?: string[];
}

export async function loadGameNights(): Promise<GameNight[]> {
  return readJson<GameNight[]>(FILE, []);
}

export async function saveGameNights(gamenights: GameNight[]): Promise<void> {
  await writeJson(FILE, gamenights);
}

export async function findGameNight(id: string): Promise<GameNight | undefined> {
  return (await loadGameNights()).find((g) => g.id === id);
}

export async function findGameNightByDiscordEventId(
  discordEventId: string,
): Promise<GameNight | undefined> {
  return (await loadGameNights()).find((g) => g.discordEventId === discordEventId);
}

export async function upsertGameNight(gamenight: GameNight): Promise<void> {
  const all = await loadGameNights();
  const idx = all.findIndex((g) => g.id === gamenight.id);
  if (idx >= 0) all[idx] = gamenight;
  else all.push(gamenight);
  await saveGameNights(all);
}
