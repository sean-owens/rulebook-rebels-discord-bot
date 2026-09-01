import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetGuildConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
}));

const mockGetActiveChallenge = vi.fn();
const mockRecordCorrectGuess = vi.fn();
vi.mock('../src/utils/boardGameChallengeStorage', () => ({
  getActiveChallenge: (...args: unknown[]) => mockGetActiveChallenge(...args),
  recordCorrectGuess: (...args: unknown[]) => mockRecordCorrectGuess(...args),
}));

const mockIsCorrectGuess = vi.fn();
vi.mock('../src/utils/boardGameChallenge', () => ({
  isCorrectGuess: (...args: unknown[]) => mockIsCorrectGuess(...args),
}));

import { handleMessageCreate } from '../src/events/messageCreate';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    author: { bot: false, id: 'user-1', send: vi.fn(async () => {}) },
    guildId: 'guild-1',
    channelId: 'channel-1',
    channel: { send: vi.fn(async () => {}) },
    content: 'Catan',
    react: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

const CHALLENGE = {
  id: 'guild-1-2026-08-24',
  guildId: 'guild-1',
  title: 'Catan',
  hintsPostedCount: 1,
  correctGuesses: [] as { userId: string }[],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGuildConfig.mockResolvedValue({ boardGameChallengeChannelId: 'channel-1' });
  mockGetActiveChallenge.mockResolvedValue(CHALLENGE);
});

describe('handleMessageCreate', () => {
  it('ignores messages from bots', async () => {
    await handleMessageCreate(makeMessage({ author: { bot: true, id: 'bot-1', send: vi.fn() } }));
    expect(mockGetGuildConfig).not.toHaveBeenCalled();
  });

  it('ignores DMs (no guildId)', async () => {
    await handleMessageCreate(makeMessage({ guildId: null }));
    expect(mockGetGuildConfig).not.toHaveBeenCalled();
  });

  it('ignores messages outside the configured channel', async () => {
    const message = makeMessage({ channelId: 'other-channel' });
    await handleMessageCreate(message);
    expect(mockGetActiveChallenge).not.toHaveBeenCalled();
    expect(message.react).not.toHaveBeenCalled();
  });

  it('does nothing when no challenge is active', async () => {
    mockGetActiveChallenge.mockResolvedValue(undefined);
    const message = makeMessage();
    await handleMessageCreate(message);
    expect(message.react).not.toHaveBeenCalled();
  });

  it('does nothing before the first hint has posted', async () => {
    mockGetActiveChallenge.mockResolvedValue({ ...CHALLENGE, hintsPostedCount: 0 });
    const message = makeMessage();
    await handleMessageCreate(message);
    expect(message.react).not.toHaveBeenCalled();
  });

  it('ignores a user who already scored this challenge', async () => {
    mockGetActiveChallenge.mockResolvedValue({
      ...CHALLENGE,
      correctGuesses: [{ userId: 'user-1' }],
    });
    const message = makeMessage();
    await handleMessageCreate(message);
    expect(mockIsCorrectGuess).not.toHaveBeenCalled();
    expect(message.react).not.toHaveBeenCalled();
  });

  it('reacts with a cross on an incorrect guess and leaves the message', async () => {
    mockIsCorrectGuess.mockReturnValue(false);
    const message = makeMessage({ content: 'Wrong Game' });

    await handleMessageCreate(message);

    expect(message.react).toHaveBeenCalledWith('❌');
    expect(message.delete).not.toHaveBeenCalled();
    expect(mockRecordCorrectGuess).not.toHaveBeenCalled();
  });

  it('deletes the message, scores, and DMs the player on a correct guess', async () => {
    mockIsCorrectGuess.mockReturnValue(true);
    mockRecordCorrectGuess.mockResolvedValue({ points: 100, totalPoints: 250 });
    const message = makeMessage({ content: 'Catan' });

    await handleMessageCreate(message);

    expect(mockRecordCorrectGuess).toHaveBeenCalledWith('guild-1', CHALLENGE.id, 'user-1', 1);
    expect(message.delete).toHaveBeenCalled();
    expect(message.channel.send).toHaveBeenCalledWith(expect.stringContaining('<@user-1>'));
    expect(message.channel.send).toHaveBeenCalledWith(expect.stringContaining('+100 points'));
    expect(message.author.send).toHaveBeenCalledWith(expect.stringContaining('100 points'));
    expect(message.author.send).toHaveBeenCalledWith(expect.stringContaining('250 points'));
    expect(message.react).not.toHaveBeenCalled();
  });

  it('does not delete/DM/announce when recordCorrectGuess reports an already-scored race', async () => {
    mockIsCorrectGuess.mockReturnValue(true);
    mockRecordCorrectGuess.mockResolvedValue(undefined);
    const message = makeMessage({ content: 'Catan' });

    await handleMessageCreate(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.author.send).not.toHaveBeenCalled();
  });
});
