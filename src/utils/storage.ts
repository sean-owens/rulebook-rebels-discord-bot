import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'gamenights.json');

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
  createdAt: string;
  requestPinMessageId?: string;
  gameListPinMessageId?: string;
  openChannel?: boolean;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadGameNights(): GameNight[] {
  ensureDataDir();
  if (!fs.existsSync(FILE)) return [];
  return JSON.parse(fs.readFileSync(FILE, 'utf-8')) as GameNight[];
}

export function saveGameNights(gamenights: GameNight[]): void {
  ensureDataDir();
  fs.writeFileSync(FILE, JSON.stringify(gamenights, null, 2));
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
  if (idx >= 0) {
    all[idx] = gamenight;
  } else {
    all.push(gamenight);
  }
  saveGameNights(all);
}
