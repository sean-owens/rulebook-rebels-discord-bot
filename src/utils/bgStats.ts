import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import QRCode from 'qrcode';
import { createShortLink, ShortLinkMeta } from './shortLinkStorage';

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
  // BG Stats' schema types `bggId` as a JSON number, not a string — sending
  // it quoted throws a CoreData type-coercion exception in the app (crashed
  // outright on macOS/Mac Catalyst; silently closed on iOS) when it tried to
  // set the game's bggId attribute from our payload.
  const bggIdNumber = bggId !== undefined ? Number(bggId) : undefined;

  const payload = {
    sourceName: SOURCE_NAME,
    sourcePlayId: opts.sourcePlayId,
    playDate: formatPlayDate(opts.playDate),
    game: {
      name: opts.gameName,
      sourceGameId,
      ...(bggIdNumber !== undefined && !Number.isNaN(bggIdNumber) ? { bggId: bggIdNumber } : {}),
      // BG Stats' docs list `highestWins`/`noPoints` as optional, but the same
      // "No value for <field>" crash we hit for winner/startPlayer applies to
      // every boolean field in this schema (the Android app's JSON parser
      // reads booleans non-optionally) — highestWins defaults to true since
      // most games score that way, and noPoints to false since we do pass
      // per-player fields expecting a score to be filled in.
      highestWins: true,
      noPoints: false,
    },
    location: opts.location,
    players: opts.players.map((p) => ({
      name: p.name,
      sourcePlayerId: p.sourcePlayerId,
      // BG Stats' docs list `winner`/`startPlayer` as optional, but the
      // Android app's JSON parser throws ("No value for <field>") if either
      // key is omitted entirely — send explicit defaults the user can correct
      // in-app once the play is set up/finished.
      winner: false,
      startPlayer: false,
    })),
  };

  const data = encodeURIComponent(JSON.stringify(payload));
  return `${BG_STATS_CREATE_PLAY_URL}?data=${data}`;
}

export function fitsDiscordButton(url: string): boolean {
  return url.length <= DISCORD_BUTTON_URL_MAX_LENGTH;
}

// Railway's dashboard displays generated domains without a scheme (e.g.
// "my-app.up.railway.app"), so SHORT_LINK_BASE_URL commonly gets set that way
// even though Discord requires a full http(s) URL for a link button — default
// to https rather than fail when the scheme was left off.
function normalizeBaseUrl(url: string): string {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * Resolves the URL to actually put on the "Log in BG Stats" button, or null
 * if no button should be shown. When SHORT_LINK_BASE_URL is configured (see
 * .env.example / src/utils/shortLinkServer.ts), always shortens the link so
 * the button works regardless of player count. Otherwise falls back to the
 * original length-check behavior — a button only when the full URL already
 * fits Discord's limit.
 */
export async function buildBgStatsButtonUrl(
  fullUrl: string,
  meta?: ShortLinkMeta,
): Promise<string | null> {
  const baseUrl = process.env.SHORT_LINK_BASE_URL;
  if (baseUrl) {
    const link = await createShortLink(fullUrl, meta);
    return `${normalizeBaseUrl(baseUrl)}/s/${link.code}`;
  }
  return fitsDiscordButton(fullUrl) ? fullUrl : null;
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
 * to scan with their phone instead of clicking the link button. Callers
 * should pass the shortest URL available (e.g. the short-link button URL,
 * falling back to the full BG Stats link only when no short link exists) —
 * fewer characters means fewer QR modules, which scans more reliably from
 * a phone camera at typical distances. Low error correction (fewer redundant
 * modules) and a generous fixed size help the same way.
 */
export async function buildBgStatsQrAttachment(
  url: string,
  filename: string,
): Promise<AttachmentBuilder> {
  const buffer = await QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'L',
    width: 300,
  });
  return new AttachmentBuilder(buffer, { name: filename });
}
