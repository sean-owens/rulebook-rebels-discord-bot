import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import QRCode from 'qrcode';

const BG_STATS_CREATE_PLAY_URL = 'https://app.bgstatsapp.com/createPlay.html';

// Discord rejects a button whose `url` exceeds this length (BASE_TYPE_MAX_LENGTH).
// The BG Stats payload grows with player count, so this fits solo/duo plays but
// not larger tables — callers must check before adding the button, and always
// fall back to the QR code (buildBgStatsQrAttachment), which has no such limit.
export const DISCORD_BUTTON_URL_MAX_LENGTH = 512;

// Identifies this bot as the source app in BG Stats' playData schema — required field.
const SOURCE_NAME = 'Rulebook Rebels Discord Bot';

export interface BgStatsPlayer {
  name: string;
  sourcePlayerId: string;
}

export interface BgStatsPlayUrlOptions {
  gameName: string;
  // GameSuggestion.bggId is '' for manually-added games — treat blank as absent.
  bggId?: string;
  location: string;
  players: BgStatsPlayer[];
  // Unique per play (e.g. the GameSuggestion id) — required by BG Stats' schema
  // so it can re-match/de-dupe pushed plays.
  sourcePlayId: string;
  playDate: Date;
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// BG Stats requires playDate as UTC 'yyyy-MM-dd HH:mm:ss', not ISO 8601.
function formatPlayDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * Builds a BG Stats "auto-posting" deep link that opens the app directly to a
 * pre-filled new-play screen. See BG Stats' "Linking and pushing to BG Stats
 * from other apps or websites" docs — the `data` param is a URL-encoded JSON
 * string with `sourceName`, `sourcePlayId`, `playDate`, `game`, `location`, and
 * `players` fields (the first three are required).
 */
export function buildBgStatsPlayUrl(opts: BgStatsPlayUrlOptions): string {
  const bggId = opts.bggId?.trim() || undefined;
  const sourceGameId = bggId ?? `manual-${slugify(opts.gameName)}`;

  const payload = {
    sourceName: SOURCE_NAME,
    sourcePlayId: opts.sourcePlayId,
    playDate: formatPlayDate(opts.playDate),
    game: {
      name: opts.gameName,
      sourceGameId,
      ...(bggId ? { bggId } : {}),
    },
    location: opts.location,
    players: opts.players.map((p) => ({
      name: p.name,
      sourcePlayerId: p.sourcePlayerId,
    })),
  };

  const data = encodeURIComponent(JSON.stringify(payload));
  return `${BG_STATS_CREATE_PLAY_URL}?data=${data}`;
}

export function fitsDiscordButton(url: string): boolean {
  return url.length <= DISCORD_BUTTON_URL_MAX_LENGTH;
}

export function buildBgStatsButton(url: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Log in BG Stats')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
}

/**
 * Renders `url` as a QR code PNG attachment, for players at a desktop/laptop
 * to scan with their phone instead of clicking the link button.
 */
export async function buildBgStatsQrAttachment(
  url: string,
  filename: string,
): Promise<AttachmentBuilder> {
  const buffer = await QRCode.toBuffer(url, { type: 'png' });
  return new AttachmentBuilder(buffer, { name: filename });
}
