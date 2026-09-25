import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { interactionTokenExpired, sendLongRunningResult } from '../src/utils/longRunningReply';

const MIN = 60 * 1000;

function makeInteraction(ageMs: number, overrides: Record<string, unknown> = {}) {
  return {
    createdTimestamp: Date.now() - ageMs,
    followUp: vi.fn(async () => {}),
    user: { id: 'admin-1', send: vi.fn(async () => {}) },
    ...overrides,
  } as any;
}

describe('interactionTokenExpired', () => {
  it('is false for a fresh interaction and true once close to the 15-minute limit', () => {
    const now = 1_000_000_000;
    expect(interactionTokenExpired(now - 1 * MIN, now)).toBe(false);
    expect(interactionTokenExpired(now - 13 * MIN, now)).toBe(false);
    expect(interactionTokenExpired(now - 14 * MIN, now)).toBe(true);
    expect(interactionTokenExpired(now - 40 * MIN, now)).toBe(true);
  });

  it('treats a missing timestamp as not expired', () => {
    expect(interactionTokenExpired(undefined as any)).toBe(false);
  });
});

describe('sendLongRunningResult', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses an ephemeral follow-up while the token is still valid', async () => {
    const interaction = makeInteraction(2 * MIN);
    expect(await sendLongRunningResult(interaction, 'Sync complete')).toBe('followup');
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: 'Sync complete' }));
    expect(interaction.user.send).not.toHaveBeenCalled();
  });

  it('DMs the result without attempting a follow-up once the token has expired', async () => {
    const interaction = makeInteraction(20 * MIN);
    expect(await sendLongRunningResult(interaction, 'Sync complete — **1004** updated, **0** failed.')).toBe('dm');
    expect(interaction.followUp).not.toHaveBeenCalled();
    const dm = interaction.user.send.mock.calls[0][0] as string;
    expect(dm).toContain('1004');
    expect(dm).toContain('longer than Discord allows');
  });

  it('falls back to a DM when a not-yet-expired follow-up is rejected anyway', async () => {
    const interaction = makeInteraction(5 * MIN, {
      followUp: vi.fn(async () => {
        throw Object.assign(new Error('Invalid Webhook Token'), { code: 50027 });
      }),
    });
    expect(await sendLongRunningResult(interaction, 'done')).toBe('dm');
    expect(interaction.user.send).toHaveBeenCalled();
  });

  it('reports failure — without throwing — when neither route works', async () => {
    const interaction = makeInteraction(20 * MIN, {
      user: { id: 'admin-1', send: vi.fn(async () => { throw new Error('Cannot send messages to this user'); }) },
    });
    await expect(sendLongRunningResult(interaction, 'done')).resolves.toBe('failed');
    expect(console.error).toHaveBeenCalled();
  });
});
