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

  it('logs a warning immediately without retrying for a non-50013 error', async () => {
    const err = new Error('Some other error');
    const target = { pin: vi.fn(async () => { throw err; }) };

    await pinWithRetry(target, 'test message');

    expect(target.pin).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not pin test message:'), err);
  });

  it('does not block on a 50013 error — the background retry has not fired yet when the call returns', async () => {
    const target = {
      pin: vi
        .fn()
        .mockRejectedValueOnce(missingPermissionsError())
        .mockResolvedValueOnce(undefined),
    };

    await pinWithRetry(target, 'test message');

    expect(target.pin).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries in the background after a delay on a 50013 error, and succeeds', async () => {
    const target = {
      pin: vi
        .fn()
        .mockRejectedValueOnce(missingPermissionsError())
        .mockResolvedValueOnce(undefined),
    };

    await pinWithRetry(target, 'test message');
    await vi.advanceTimersByTimeAsync(2000);

    expect(target.pin).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps retrying in the background with increasing delays until one succeeds', async () => {
    const target = {
      pin: vi
        .fn()
        .mockRejectedValueOnce(missingPermissionsError())
        .mockRejectedValueOnce(missingPermissionsError())
        .mockRejectedValueOnce(missingPermissionsError())
        .mockResolvedValueOnce(undefined),
    };

    await pinWithRetry(target, 'test message');
    await vi.advanceTimersByTimeAsync(2000); // 1st background retry — fails
    await vi.advanceTimersByTimeAsync(5000); // 2nd — fails
    await vi.advanceTimersByTimeAsync(10000); // 3rd — succeeds

    expect(target.pin).toHaveBeenCalledTimes(4);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning once every background retry is exhausted', async () => {
    const err = missingPermissionsError();
    const target = { pin: vi.fn(async () => { throw err; }) };

    await pinWithRetry(target, 'test message');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(20000);

    expect(target.pin).toHaveBeenCalledTimes(5); // 1 initial attempt + 4 background retries
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gave up after 4 background retries'));
  });

  it('stops retrying in the background on a non-50013 error mid-chain', async () => {
    const otherErr = new Error('Unknown Message');
    const target = {
      pin: vi
        .fn()
        .mockRejectedValueOnce(missingPermissionsError())
        .mockRejectedValueOnce(otherErr),
    };

    await pinWithRetry(target, 'test message');
    await vi.advanceTimersByTimeAsync(2000);

    expect(target.pin).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not pin test message:'), otherErr);

    warnSpy.mockClear();
    await vi.advanceTimersByTimeAsync(30000);
    expect(target.pin).toHaveBeenCalledTimes(2); // no further attempts after giving up
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
