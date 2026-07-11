import { describe, it, expect } from 'vitest';
import { ButtonStyle } from 'discord.js';
import { buildBgStatsPlayUrl, buildBgStatsButton, buildBgStatsQrAttachment } from '../src/utils/bgStats';

const PLAY_DATE = new Date('2026-07-11T19:30:00.000Z');

function decodeDataParam(url: string): any {
  const query = url.split('?data=')[1];
  return JSON.parse(decodeURIComponent(query));
}

describe('buildBgStatsPlayUrl', () => {
  it('builds a well-formed createPlay.html URL with all required and optional fields', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Wingspan',
      bggId: '266192',
      location: "Sean's place",
      players: [
        { name: 'sean_o', sourcePlayerId: 'user-1' },
        { name: 'user-2', sourcePlayerId: 'user-2' },
      ],
      sourcePlayId: 'game-1',
      playDate: PLAY_DATE,
    });

    expect(url.startsWith('https://app.bgstatsapp.com/createPlay.html?data=')).toBe(true);

    const data = decodeDataParam(url);
    expect(data).toEqual({
      sourceName: 'Rulebook Rebels Discord Bot',
      sourcePlayId: 'game-1',
      playDate: '2026-07-11 19:30:00',
      game: { name: 'Wingspan', sourceGameId: '266192', bggId: '266192' },
      location: "Sean's place",
      players: [
        { name: 'sean_o', sourcePlayerId: 'user-1' },
        { name: 'user-2', sourcePlayerId: 'user-2' },
      ],
    });
  });

  it('falls back to a slugified sourceGameId when bggId is blank (manually-added games)', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Homemade Trivia Night!',
      bggId: '',
      location: 'TBD',
      players: [],
      sourcePlayId: 'game-2',
      playDate: PLAY_DATE,
    });

    const data = decodeDataParam(url);
    expect(data.game.name).toBe('Homemade Trivia Night!');
    expect(data.game.sourceGameId).toBe('manual-homemade-trivia-night');
    expect(data.game.bggId).toBeUndefined();
  });

  it('treats an undefined bggId the same as blank', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Some Game',
      location: 'TBD',
      players: [],
      sourcePlayId: 'game-3',
      playDate: PLAY_DATE,
    });

    const data = decodeDataParam(url);
    expect(data.game.sourceGameId).toBe('manual-some-game');
    expect(data.game.bggId).toBeUndefined();
  });

  it('formats playDate as UTC yyyy-MM-dd HH:mm:ss regardless of local timezone', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Some Game',
      location: '',
      players: [],
      sourcePlayId: 'game-4',
      playDate: new Date('2026-01-05T03:05:09.000Z'),
    });

    const data = decodeDataParam(url);
    expect(data.playDate).toBe('2026-01-05 03:05:09');
  });
});

describe('buildBgStatsButton', () => {
  it('returns a single link-style button pointing at the given URL', () => {
    const url = 'https://app.bgstatsapp.com/createPlay.html?data=abc';
    const row = buildBgStatsButton(url);
    const json = row.toJSON();

    expect(json.components).toHaveLength(1);
    const button = json.components[0] as any;
    expect(button.style).toBe(ButtonStyle.Link);
    expect(button.url).toBe(url);
    expect(button.label).toBe('Log in BG Stats');
  });
});

describe('buildBgStatsQrAttachment', () => {
  it('returns a PNG attachment encoding the given URL', async () => {
    const url = 'https://app.bgstatsapp.com/createPlay.html?data=abc';
    const attachment = await buildBgStatsQrAttachment(url, 'bgstats-game-1.png');
    const json = attachment.toJSON();

    expect(json.name).toBe('bgstats-game-1.png');
    expect(Buffer.isBuffer(attachment.attachment)).toBe(true);
    expect((attachment.attachment as Buffer).length).toBeGreaterThan(0);
  });
});
