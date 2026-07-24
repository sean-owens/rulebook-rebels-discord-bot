import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ButtonStyle } from 'discord.js';
import {
  buildBgStatsPlayUrl,
  buildBgStatsButton,
  buildBgStatsButtonUrl,
  buildBgStatsQrAttachment,
  fitsDiscordButton,
  DISCORD_BUTTON_URL_MAX_LENGTH,
} from '../src/utils/bgStats';
import { findShortLink } from '../src/utils/shortLinkStorage';

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
      game: {
        name: 'Wingspan',
        sourceGameId: '266192',
        bggId: 266192,
        highestWins: true,
        noPoints: false,
      },
      location: "Sean's place",
      players: [
        { name: 'sean_o', sourcePlayerId: 'user-1', winner: false, startPlayer: false },
        { name: 'user-2', sourcePlayerId: 'user-2', winner: false, startPlayer: false },
      ],
    });
  });

  it('includes explicit winner:false and startPlayer:false per player — BG Stats\' Android app throws "No value for <field>" if either key is omitted, even though both are documented as optional', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Wingspan',
      location: 'TBD',
      players: [{ name: 'sean_o', sourcePlayerId: 'user-1' }],
      sourcePlayId: 'game-5',
      playDate: PLAY_DATE,
    });

    const data = decodeDataParam(url);
    expect(data.players[0].winner).toBe(false);
    expect(data.players[0].startPlayer).toBe(false);
  });

  // Regression case: same "No value for <field>" crash, this time for the
  // game object's boolean fields rather than a player's.
  it('includes explicit game.highestWins:true and game.noPoints:false — same "No value for <field>" crash applies to every boolean in this schema', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Wingspan',
      location: 'TBD',
      players: [],
      sourcePlayId: 'game-6',
      playDate: PLAY_DATE,
    });

    const data = decodeDataParam(url);
    expect(data.game.highestWins).toBe(true);
    expect(data.game.noPoints).toBe(false);
  });

  // Regression case: BG Stats' schema types game.bggId as a JSON number, not
  // a string. We stored bggId as a string internally (GameSuggestion.bggId),
  // and previously passed it through verbatim — sending a quoted string threw
  // a CoreData type-coercion exception in the app, crashing outright on
  // macOS/Mac Catalyst and silently closing on iOS.
  it('sends game.bggId as a JSON number, not a string', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Wingspan',
      bggId: '266192',
      location: 'TBD',
      players: [],
      sourcePlayId: 'game-7',
      playDate: PLAY_DATE,
    });

    const data = decodeDataParam(url);
    expect(data.game.bggId).toBe(266192);
    expect(typeof data.game.bggId).toBe('number');
  });

  it('omits bggId rather than sending NaN when it is non-numeric', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Weird Game',
      bggId: 'not-a-number',
      location: 'TBD',
      players: [],
      sourcePlayId: 'game-8',
      playDate: PLAY_DATE,
    });

    const data = decodeDataParam(url);
    expect(data.game.bggId).toBeUndefined();
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

describe('fitsDiscordButton', () => {
  it('returns true at or under the limit and false just past it', () => {
    expect(fitsDiscordButton('a'.repeat(DISCORD_BUTTON_URL_MAX_LENGTH))).toBe(true);
    expect(fitsDiscordButton('a'.repeat(DISCORD_BUTTON_URL_MAX_LENGTH + 1))).toBe(false);
  });

  // Regression case: BG Stats' link grows with player count, and Discord's
  // /game bgstats command crashed in production the moment a game had more
  // than a couple of seated players, because the button URL exceeded
  // Discord's 512-char limit and Discord rejected the whole interaction.
  it('flags a realistic multi-player game as too long for a Discord button', () => {
    const players = Array.from({ length: 4 }, (_, i) => ({
      name: `player_name_${i}`,
      sourcePlayerId: `12345678901234567${i}`,
    }));
    const url = buildBgStatsPlayUrl({
      gameName: 'Wingspan',
      bggId: '266192',
      location: 'The Rec Room',
      players,
      sourcePlayId: 'game-1',
      playDate: PLAY_DATE,
    });

    expect(fitsDiscordButton(url)).toBe(false);
  });

  // Once every field BG Stats' Android app actually requires (winner,
  // startPlayer, highestWins, noPoints) is included, even a solo play with a
  // full-length Discord snowflake ID no longer fits under 512 chars without
  // the short-link server — this is exactly why buildBgStatsButtonUrl exists.
  it('no longer fits even a solo play once every required field is included, without a short link', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Wingspan',
      bggId: '266192',
      location: 'The Rec Room',
      players: [{ name: 'sean_o', sourcePlayerId: '123456789012345678' }],
      sourcePlayId: 'game-1',
      playDate: PLAY_DATE,
    });

    expect(fitsDiscordButton(url)).toBe(false);
  });

  it('fits a minimal play with no players and a short name', () => {
    const url = buildBgStatsPlayUrl({
      gameName: 'Go',
      location: '',
      players: [],
      sourcePlayId: 'g1',
      playDate: PLAY_DATE,
    });

    expect(fitsDiscordButton(url)).toBe(true);
  });
});

describe('buildBgStatsButtonUrl', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bgstats-buttonurl-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('falls back to the length-check behavior when SHORT_LINK_BASE_URL is unset', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', '');

    const longUrl = buildBgStatsPlayUrl({
      gameName: 'Wingspan',
      bggId: '266192',
      location: 'The Rec Room',
      players: Array.from({ length: 4 }, (_, i) => ({
        name: `player_name_${i}`,
        sourcePlayerId: `12345678901234567${i}`,
      })),
      sourcePlayId: 'game-1',
      playDate: PLAY_DATE,
    });

    expect(await buildBgStatsButtonUrl(longUrl)).toBeNull();

    const shortUrl = 'https://app.bgstatsapp.com/createPlay.html?data=abc';
    expect(await buildBgStatsButtonUrl(shortUrl)).toBe(shortUrl);
  });

  // Regression case: even a real 2-player game's link exceeds Discord's
  // 512-char button limit (confirmed against production), so the button
  // silently never appeared for genuine multi-player games. A short link
  // fixes that regardless of player count.
  it('returns a short redirect link and persists the full URL when SHORT_LINK_BASE_URL is set', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com');

    const longUrl = buildBgStatsPlayUrl({
      gameName: 'Sky Team',
      location: '',
      players: [
        { name: 'snwns1', sourcePlayerId: '111111111111111111' },
        { name: 'Bucko77', sourcePlayerId: '222222222222222222' },
      ],
      sourcePlayId: 'game-1',
      playDate: PLAY_DATE,
    });
    expect(fitsDiscordButton(longUrl)).toBe(false);

    const buttonUrl = await buildBgStatsButtonUrl(longUrl);
    expect(buttonUrl).toMatch(/^https:\/\/bot\.example\.com\/s\/[A-Za-z0-9_-]+$/);
    expect(fitsDiscordButton(buttonUrl!)).toBe(true);

    const code = buttonUrl!.split('/s/')[1];
    const stored = await findShortLink(code);
    expect(stored?.url).toBe(longUrl);
  });

  it('threads guild/event/game attribution through to the stored short link', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com');

    const buttonUrl = await buildBgStatsButtonUrl(
      'https://app.bgstatsapp.com/createPlay.html?data=abc',
      { guildId: 'guild-1', eventId: 'event-1', gameId: 'game-1' },
    );
    const code = buttonUrl!.split('/s/')[1];
    const stored = await findShortLink(code);
    expect(stored?.guildId).toBe('guild-1');
    expect(stored?.eventId).toBe('event-1');
    expect(stored?.gameId).toBe('game-1');
    expect(stored?.openCount).toBe(0);
  });

  it('strips a trailing slash from SHORT_LINK_BASE_URL', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'https://bot.example.com/');

    const buttonUrl = await buildBgStatsButtonUrl(
      'https://app.bgstatsapp.com/createPlay.html?data=abc',
    );
    expect(buttonUrl).not.toContain('.com//s/');
  });

  // Regression: Railway's dashboard shows generated domains without a scheme
  // (e.g. "my-app.up.railway.app"), so SHORT_LINK_BASE_URL was set that way in
  // both .env and the Railway dashboard — producing a schemeless button URL
  // that Discord would reject.
  it('defaults to https:// when SHORT_LINK_BASE_URL has no scheme', async () => {
    vi.stubEnv('SHORT_LINK_BASE_URL', 'my-app.up.railway.app');

    const buttonUrl = await buildBgStatsButtonUrl(
      'https://app.bgstatsapp.com/createPlay.html?data=abc',
    );
    expect(buttonUrl).toMatch(/^https:\/\/my-app\.up\.railway\.app\/s\/[A-Za-z0-9_-]+$/);
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
