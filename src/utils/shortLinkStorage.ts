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

export async function createShortLink(url: string): Promise<ShortLink> {
  const now = new Date();
  const link: ShortLink = {
    code: generateShortCode(),
    url,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHORT_LINK_TTL_MS).toISOString(),
  };
  const links = await loadShortLinks();
  links.push(link);
  await saveShortLinks(links);
  return link;
}

export async function cleanupExpiredShortLinks(): Promise<void> {
  const now = new Date();
  const links = await loadShortLinks();
  const remaining = links.filter((l) => new Date(l.expiresAt) > now);
  if (remaining.length !== links.length) {
    await saveShortLinks(remaining);
  }
}
