import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  JOIN_ANNOUNCEMENT_TEMPLATES,
  pickJoinAnnouncementText,
  resolveAnnouncementImage,
  waveButtonCustomId,
  waveButtonTargetUserId,
  WAVE_BUTTON_PREFIX,
  WELCOME_ANNOUNCEMENT_DEFAULT_GIF_PATH,
} from '../src/utils/welcomeAnnouncement';

describe('pickJoinAnnouncementText', () => {
  it('picks the first template when rng returns 0', () => {
    const text = pickJoinAnnouncementText('<@user-1>', 'Rulebook Rebels', () => 0);
    expect(text).toBe(JOIN_ANNOUNCEMENT_TEMPLATES[0]('<@user-1>', 'Rulebook Rebels'));
  });

  it('picks the last template when rng returns just under 1', () => {
    const text = pickJoinAnnouncementText('<@user-1>', 'Rulebook Rebels', () => 0.9999);
    const lastIndex = JOIN_ANNOUNCEMENT_TEMPLATES.length - 1;
    expect(text).toBe(JOIN_ANNOUNCEMENT_TEMPLATES[lastIndex]('<@user-1>', 'Rulebook Rebels'));
  });

  it('every template includes the member mention and guild name', () => {
    for (let i = 0; i < JOIN_ANNOUNCEMENT_TEMPLATES.length; i++) {
      const text = JOIN_ANNOUNCEMENT_TEMPLATES[i]('<@user-1>', 'Rulebook Rebels');
      expect(text).toContain('<@user-1>');
      expect(text).toContain('Rulebook Rebels');
    }
  });
});

describe('wave button customId helpers', () => {
  it('round-trips a target user id through customId and back', () => {
    const customId = waveButtonCustomId('12345');
    expect(customId).toBe(`${WAVE_BUTTON_PREFIX}12345`);
    expect(waveButtonTargetUserId(customId)).toBe('12345');
  });
});

describe('resolveAnnouncementImage', () => {
  it('prefers a configured URL over the bundled default', () => {
    const image = resolveAnnouncementImage('https://example.com/wave.gif', () => true);
    expect(image).toEqual({ type: 'url', value: 'https://example.com/wave.gif' });
  });

  it('falls back to the bundled default asset when no URL is configured and it exists', () => {
    const image = resolveAnnouncementImage(undefined, () => true);
    expect(image).toEqual({
      type: 'attachment',
      filename: path.basename(WELCOME_ANNOUNCEMENT_DEFAULT_GIF_PATH),
      fullPath: path.join(process.cwd(), WELCOME_ANNOUNCEMENT_DEFAULT_GIF_PATH),
    });
  });

  it('returns undefined when no URL is configured and the bundled default is missing', () => {
    const image = resolveAnnouncementImage(undefined, () => false);
    expect(image).toBeUndefined();
  });

  it('returns undefined when configuredUrl is an empty string and no default asset exists', () => {
    const image = resolveAnnouncementImage('', () => false);
    expect(image).toBeUndefined();
  });
});
