import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetGuildConfig = vi.fn();
vi.mock('../src/utils/config', () => ({
  getGuildConfig: (...args: unknown[]) => mockGetGuildConfig(...args),
}));

const mockGetActiveChallenge = vi.fn();
vi.mock('../src/utils/boardGameChallengeStorage', () => ({
  getActiveChallenge: (...args: unknown[]) => mockGetActiveChallenge(...args),
}));

const mockClassify = vi.fn();
const mockFindCandidates = vi.fn();
const mockAward = vi.fn();
vi.mock('../src/utils/boardGameChallenge', () => ({
  classifyGuessMatch: (...args: unknown[]) => mockClassify(...args),
  findDisambiguationCandidates: (...args: unknown[]) => mockFindCandidates(...args),
  awardCorrectGuess: (...args: unknown[]) => mockAward(...args),
}));

import { handleMessageCreate } from '../src/events/messageCreate';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    author: { bot: false, id: 'user-1', send: vi.fn(async () => {}) },
    guildId: 'guild-1',
    channelId: 'channel-1',
    channel: { send: vi.fn(async () => {}) },
    client: { user: { id: 'bot-1' } },
    content: 'Catan',
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

const CHALLENGE = {
  id: 'guild-1-2026-08-24',
  guildId: 'guild-1',
  title: 'Catan',
  bggId: '13',
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
    expect(mockClassify).not.toHaveBeenCalled();
    expect(message.react).not.toHaveBeenCalled();
  });

  it('reacts with a cross on an incorrect guess and leaves the message', async () => {
    mockClassify.mockReturnValue('none');
    const message = makeMessage({ content: 'Wrong Game' });

    await handleMessageCreate(message);

    expect(message.react).toHaveBeenCalledWith('❌');
    expect(message.delete).not.toHaveBeenCalled();
    expect(mockAward).not.toHaveBeenCalled();
  });

  it('awards the guess and deletes the message on a correct guess', async () => {
    mockClassify.mockReturnValue('full');
    mockAward.mockResolvedValue({ points: 100, totalPoints: 250 });
    const message = makeMessage({ content: 'Catan' });

    await handleMessageCreate(message);

    expect(mockAward).toHaveBeenCalledWith(message.client, 'guild-1', CHALLENGE, 'user-1', message.channel);
    expect(message.delete).toHaveBeenCalled();
    expect(message.react).not.toHaveBeenCalled();
  });

  it('does not delete the message when awardCorrectGuess reports an already-scored race', async () => {
    mockClassify.mockReturnValue('full');
    mockAward.mockResolvedValue(undefined);
    const message = makeMessage({ content: 'Catan' });

    await handleMessageCreate(message);

    expect(message.delete).not.toHaveBeenCalled();
  });

  describe('base-only guesses', () => {
    it('sends a dropdown instead of scoring when 2+ catalog games share the base', async () => {
      mockClassify.mockReturnValue('base');
      mockFindCandidates.mockReturnValue([
        { id: '13', name: 'Catan', year: 1995, isExpansion: false, rank: 1 },
        { id: '14', name: 'Catan: Seafarers', year: 1997, isExpansion: false, rank: 2 },
      ]);
      const message = makeMessage({ content: 'Catan' });

      await handleMessageCreate(message);

      expect(mockFindCandidates).toHaveBeenCalledWith('Catan', '13');
      expect(message.reply).toHaveBeenCalledTimes(1);
      const payload = message.reply.mock.calls[0][0];
      expect(payload.components).toHaveLength(1);
      const menu = payload.components[0].toJSON().components[0];
      expect(menu.custom_id).toBe(`bgchallenge_disambig_${CHALLENGE.id}_user-1`);
      expect(menu.options.map((o: any) => o.value)).toEqual(['13', '14']);
      expect(mockAward).not.toHaveBeenCalled();
      expect(message.react).not.toHaveBeenCalled();
    });

    it('scores immediately when the base is not shared by another game', async () => {
      mockClassify.mockReturnValue('base');
      mockFindCandidates.mockReturnValue([{ id: '13', name: 'Catan', year: 1995, isExpansion: false, rank: 1 }]);
      mockAward.mockResolvedValue({ points: 100, totalPoints: 100 });
      const message = makeMessage();

      await handleMessageCreate(message);

      expect(message.reply).not.toHaveBeenCalled();
      expect(mockAward).toHaveBeenCalled();
    });

    it('does not look for candidates on a full/subtitle match', async () => {
      mockClassify.mockReturnValue('subtitle');
      mockAward.mockResolvedValue({ points: 100, totalPoints: 100 });

      await handleMessageCreate(makeMessage());

      expect(mockFindCandidates).not.toHaveBeenCalled();
    });
  });
});
