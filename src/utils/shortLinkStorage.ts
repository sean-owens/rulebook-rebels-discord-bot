import crypto from 'crypto';
import { readJson, writeJson } from './db';

const FILE = 'shortlinks.json';

// Redirect helpers created for the BG Stats button (see src/utils/bgStats.ts).
// Not guild-scoped and deliberately excluded from the guild-deletion data
// purge (src/utils/guildLifecycle.ts) — these are ephemeral redirect targets,
// not durable per-guild data, and expire on their own via cleanupExpiredShortLinks.
export interface ShortLink {
  code: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  // Attribution for BG Stats links (see src/utils/bgStats.ts) — lets multiple
  // codes for the same game (the lock-time auto-post plus any later manual
  // /game bgstats regenerations, each of which mints a fresh code) be summed
  // back together via getShortLinkStatsForGame. Absent for any short link
  // created without this context.
  guildId?: string;
  eventId?: string;
  gameId?: string;
  openCount: number;
  lastOpenedAt?: string;
}

export interface ShortLinkMeta {
  guildId: string;
  eventId: string;
  gameId: string;
}

const SHORT_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function generateShortCode(): string {
  return crypto.randomBytes(6).toString('base64url');
}

export async function loadShortLinks(): Promise<ShortLink[]> {
  return readJson<ShortLink[]>(FILE, []);
}

export async function saveShortLinks(links: ShortLink[]): Promise<void> {
  await writeJson(FILE, links);
}

export async function findShortLink(code: string): Promise<ShortLink | undefined> {
  return (await loadShortLinks()).find((l) => l.code === code);
}

export async function createShortLink(url: string, meta?: ShortLinkMeta): Promise<ShortLink> {
  const now = new Date();
  const link: ShortLink = {
    code: generateShortCode(),
    url,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHORT_LINK_TTL_MS).toISOString(),
    openCount: 0,
    ...meta,
  };
  const links = await loadShortLinks();
  links.push(link);
  await saveShortLinks(links);
  return link;
}

// Best-effort — called from the redirect hop itself (shortLinkServer.ts), so
// a failed write here should never block serving the landing page.
export async function recordShortLinkOpen(code: string): Promise<void> {
  const links = await loadShortLinks();
  const link = links.find((l) => l.code === code);
  if (!link) return;
  link.openCount += 1;
  link.lastOpenedAt = new Date().toISOString();
  await saveShortLinks(links);
}

export async function getShortLinkStatsForGame(
  guildId: string,
  eventId: string,
  gameId: string,
): Promise<{ openCount: number; lastOpenedAt?: string }> {
  const matches = (await loadShortLinks()).filter(
    (l) => l.guildId === guildId && l.eventId === eventId && l.gameId === gameId,
  );
  const openCount = matches.reduce((sum, l) => sum + l.openCount, 0);
  const lastOpenedAt = matches
    .map((l) => l.lastOpenedAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);
  return { openCount, lastOpenedAt };
}

export async function cleanupExpiredShortLinks(): Promise<void> {
  const now = new Date();
  const links = await loadShortLinks();
  const remaining = links.filter((l) => new Date(l.expiresAt) > now);
  if (remaining.length !== links.length) {
    await saveShortLinks(remaining);
  }
}
