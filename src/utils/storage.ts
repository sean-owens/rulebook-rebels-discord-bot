import { readJson, writeJson } from './db';

const FILE = 'gamenights.json';

export interface GameNight {
  id: string;
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
  createdAt: string;
  requestPinMessageId?: string;
  gameListPinMessageId?: string;
  openChannel?: boolean;
}

export function loadGameNights(): GameNight[] {
  return readJson<GameNight[]>(FILE, []);
}

export function saveGameNights(gamenights: GameNight[]): void {
  writeJson(FILE, gamenights);
}

export function findGameNight(id: string): GameNight | undefined {
  return loadGameNights().find(g => g.id === id);
}

export function findGameNightByDiscordEventId(discordEventId: string): GameNight | undefined {
  return loadGameNights().find(g => g.discordEventId === discordEventId);
}

export function upsertGameNight(gamenight: GameNight): void {
  const all = loadGameNights();
  const idx = all.findIndex(g => g.id === gamenight.id);
  if (idx >= 0) all[idx] = gamenight;
  else all.push(gamenight);
  saveGameNights(all);
}
