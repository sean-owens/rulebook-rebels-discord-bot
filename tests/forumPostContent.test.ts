import { describe, it, expect } from 'vitest';
import { buildForumPostContent, FORUM_POST_ALLOWED_MENTIONS } from '../src/utils/embeds';
import type { GameNight } from '../src/utils/storage';

const START = '2026-10-24T16:00:00.000Z';
const END = '2026-11-24T01:00:00.000Z';
const START_UNIX = Math.floor(new Date(START).getTime() / 1000);
const END_UNIX = Math.floor(new Date(END).getTime() / 1000);

function makeGameNight(overrides: Partial<GameNight> = {}): GameNight {
  return {
    id: 'abc12345',
    title: 'Monthly Board Game Meetup',
    date: 'Saturday, October 24, 2026',
    time: '11:00 AM',
    location: "Sean's House",
    description: '',
    startTimeISO: START,
    endTimeISO: END,
    rsvps: { yes: [], maybe: [], no: [] },
    ...overrides,
  } as GameNight;
}

describe('buildForumPostContent (#112 — forum cards only preview post text, not embeds)', () => {
  it('leads with the @everyone ping, then the time and location', () => {
    const lines = buildForumPostContent(makeGameNight()).split('\n');
    expect(lines[0]).toBe('@everyone');
    expect(lines[1]).toBe(`📅 <t:${START_UNIX}:F> – <t:${END_UNIX}:t>`);
    expect(lines[2]).toBe("📍 Sean's House");
  });

  it('shows only the start time when the event has no end time', () => {
    const content = buildForumPostContent(makeGameNight({ endTimeISO: null }));
    expect(content).toContain(`📅 <t:${START_UNIX}:F>`);
    expect(content).not.toContain(`<t:${END_UNIX}`);
  });

  it('falls back to TBD when there is no location', () => {
    expect(buildForumPostContent(makeGameNight({ location: '' }))).toContain('📍 TBD');
  });

  it('adds the description as a final line when there is one', () => {
    const lines = buildForumPostContent(makeGameNight({ description: 'Bring snacks!' })).split('\n');
    expect(lines[lines.length - 1]).toBe('Bring snacks!');
  });

  it('omits the description line when it is blank or whitespace', () => {
    expect(buildForumPostContent(makeGameNight({ description: '   ' })).split('\n')).toHaveLength(3);
    expect(buildForumPostContent(makeGameNight({ description: '' })).split('\n')).toHaveLength(3);
  });

  it('truncates a long description so the card preview stays short', () => {
    const content = buildForumPostContent(makeGameNight({ description: 'x'.repeat(1000) }));
    const last = content.split('\n').pop()!;
    expect(last.length).toBeLessThanOrEqual(300);
    expect(last.endsWith('…')).toBe(true);
  });

  it('stays far inside the 2000-character message limit even with maximal free text', () => {
    const content = buildForumPostContent(
      makeGameNight({ location: 'L'.repeat(500), description: 'D'.repeat(5000) }),
    );
    expect(content.length).toBeLessThan(2000);
  });

  describe('host-typed text cannot trigger extra pings', () => {
    function pingable(text: string): boolean {
      // After defusing, no raw "@everyone"/"@here" or <@id>/<@&id>/<#id> token may remain
      // anywhere other than the deliberate first line.
      const rest = text.split('\n').slice(1).join('\n');
      return /@(everyone|here)/.test(rest) || /<(@[!&]?|#)\d+>/.test(rest);
    }

    it('defuses @everyone and @here in the location', () => {
      expect(pingable(buildForumPostContent(makeGameNight({ location: '@everyone come, @here too' })))).toBe(false);
    });

    it('defuses @everyone and @here in the description', () => {
      expect(pingable(buildForumPostContent(makeGameNight({ description: 'hey @everyone and @here' })))).toBe(false);
    });

    it('defuses user and role mentions in the description', () => {
      const content = buildForumPostContent(makeGameNight({ description: 'ping <@123456> and <@&987654> in <#555>' }));
      expect(pingable(content)).toBe(false);
    });

    it('keeps the visible wording of the text', () => {
      const content = buildForumPostContent(makeGameNight({ location: 'Cafe @ the park' }));
      // The zero-width space is invisible, so stripping it recovers the original text.
      expect(content.replace(/​/g, '')).toContain('📍 Cafe @ the park');
    });

    it('only permits the one deliberate @everyone — no user or role pings', () => {
      expect(FORUM_POST_ALLOWED_MENTIONS).toEqual({ parse: ['everyone'] });
    });
  });
});
