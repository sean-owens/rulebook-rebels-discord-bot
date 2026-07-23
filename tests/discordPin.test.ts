import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pinWithRetry } from '../src/utils/discordPin';

function missingPermissionsError(): Error {
  return Object.assign(new Error('Missing Permissions'), { code: 50013 });
}

describe('pinWithRetry', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('pins successfully on the first try with no retry and no warning', async () => {
    const target = { pin: vi.fn(async () => undefined) };

    await pinWithRetry(target, 'test message');

    expect(target.pin).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries once after a delay on a 50013 Missing Permissions error, and succeeds', async () => {
    const target = {
      pin: vi
        .fn()
        .mockRejectedValueOnce(missingPermissionsError())
        .mockResolvedValueOnce(undefined),
    };

    const promise = pinWithRetry(target, 'test message');
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(target.pin).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning immediately without retrying for a non-50013 error', async () => {
    const err = new Error('Some other error');
    const target = { pin: vi.fn(async () => { throw err; }) };

    await pinWithRetry(target, 'test message');

    expect(target.pin).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not pin test message:'), err);
  });

  it('logs a warning after the retry also fails with 50013', async () => {
    const err = missingPermissionsError();
    const target = { pin: vi.fn(async () => { throw err; }) };

    const promise = pinWithRetry(target, 'test message');
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(target.pin).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retried once'), err);
  });
});
