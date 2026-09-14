import fs from 'fs';
import path from 'path';

// Randomized flavor text for the public new-member announcement (see
// handleGuildMemberAdd in src/events/guildMemberAdd.ts), styled after
// Discord's own native "X just slid into the server" system messages.
export const JOIN_ANNOUNCEMENT_TEMPLATES: Array<
  (memberMention: string, guildName: string) => string
> = [
  (memberMention, guildName) => `🌊 ${memberMention} just slid into **${guildName}**!`,
  (memberMention, guildName) => `🚀 ${memberMention} has landed in **${guildName}**!`,
  (memberMention, guildName) => `🎲 ${memberMention} rolled into **${guildName}**!`,
  (memberMention, guildName) => `🎉 Everyone welcome ${memberMention} to **${guildName}**!`,
  (memberMention, guildName) => `🪄 ${memberMention} appeared in **${guildName}**!`,
];

export function pickJoinAnnouncementText(
  memberMention: string,
  guildName: string,
  rng: () => number = Math.random,
): string {
  const index = Math.floor(rng() * JOIN_ANNOUNCEMENT_TEMPLATES.length);
  return JOIN_ANNOUNCEMENT_TEMPLATES[index](memberMention, guildName);
}

// Button customId format: `welcome_wave_<newMemberUserId>` — dispatched in
// src/events/interactionCreate.ts to handleWelcomeWaveButton.
export const WAVE_BUTTON_PREFIX = 'welcome_wave_';

export function waveButtonCustomId(targetUserId: string): string {
  return `${WAVE_BUTTON_PREFIX}${targetUserId}`;
}

export function waveButtonTargetUserId(customId: string): string {
  return customId.slice(WAVE_BUTTON_PREFIX.length);
}

// Bundled default "hello" GIF/character shown on the join announcement when
// a server hasn't set its own via /admin welcome config
// announcement_image_url (see src/commands/welcome.ts). Drop a file at this
// path (following the BGG logo pattern in src/commands/bgg.ts) to enable it —
// resolveAnnouncementImage falls back to no image if it's missing, so this
// stays a no-op until an asset is actually provided.
export const WELCOME_ANNOUNCEMENT_DEFAULT_GIF_PATH = 'assets/images/welcome-wave.gif';

export type AnnouncementImage =
  { type: 'url'; value: string } | { type: 'attachment'; filename: string; fullPath: string };

export function resolveAnnouncementImage(
  configuredUrl: string | undefined,
  existsFn: (filePath: string) => boolean = fs.existsSync,
): AnnouncementImage | undefined {
  if (configuredUrl) return { type: 'url', value: configuredUrl };

  const fullPath = path.join(process.cwd(), WELCOME_ANNOUNCEMENT_DEFAULT_GIF_PATH);
  if (!existsFn(fullPath)) return undefined;

  return { type: 'attachment', filename: path.basename(fullPath), fullPath };
}
