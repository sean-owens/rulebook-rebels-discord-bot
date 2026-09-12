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
