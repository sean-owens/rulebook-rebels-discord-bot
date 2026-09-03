import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkBggCatalogReminder } from '../src/utils/bggCatalogReminder';

vi.mock('../src/utils/db', () => ({
  readJson: vi.fn(async (_: string, fallback: unknown) => fallback),
  writeJson: vi.fn(async () => {}),
}));

import { readJson, writeJson } from '../src/utils/db';

function makeClient(sendImpl?: () => Promise<unknown>) {
  const send = vi.fn(sendImpl ?? (async () => undefined));
  const fetch = vi.fn(async () => ({ send }));
  return {
    client: { users: { fetch } } as unknown as Parameters<typeof checkBggCatalogReminder>[0],
    fetch,
    send,
  };
}

describe('checkBggCatalogReminder', () => {
  const ORIGINAL_ENV = process.env.BGG_CATALOG_MAINTAINER_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    (readJson as ReturnType<typeof vi.fn>).mockImplementation(
      async (_: string, fallback: unknown) => fallback,
    );
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.BGG_CATALOG_MAINTAINER_ID;
    else process.env.BGG_CATALOG_MAINTAINER_ID = ORIGINAL_ENV;
  });

  it('does nothing when BGG_CATALOG_MAINTAINER_ID is unset', async () => {
    delete process.env.BGG_CATALOG_MAINTAINER_ID;
    const { client, fetch } = makeClient();
    await checkBggCatalogReminder(client);
    expect(fetch).not.toHaveBeenCalled();
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('sends and marks when never sent before', async () => {
    process.env.BGG_CATALOG_MAINTAINER_ID = 'user-1';
    const { client, fetch, send } = makeClient();
    await checkBggCatalogReminder(client);
    expect(fetch).toHaveBeenCalledWith('user-1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(writeJson).toHaveBeenCalledWith(
      'system_state.json',
      expect.objectContaining({ bggCatalogReminderSentAt: expect.any(String) }),
    );
  });

  it('does nothing when sent less than 7 days ago', async () => {
    process.env.BGG_CATALOG_MAINTAINER_ID = 'user-1';
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    (readJson as ReturnType<typeof vi.fn>).mockResolvedValue({ bggCatalogReminderSentAt: recent });
    const { client, fetch } = makeClient();
    await checkBggCatalogReminder(client);
    expect(fetch).not.toHaveBeenCalled();
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('sends and re-marks when sent 7 or more days ago', async () => {
    process.env.BGG_CATALOG_MAINTAINER_ID = 'user-1';
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    (readJson as ReturnType<typeof vi.fn>).mockResolvedValue({ bggCatalogReminderSentAt: stale });
    const { client, fetch, send } = makeClient();
    await checkBggCatalogReminder(client);
    expect(fetch).toHaveBeenCalledWith('user-1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(writeJson).toHaveBeenCalled();
  });

  it('still marks as sent and does not throw when the DM fails', async () => {
    process.env.BGG_CATALOG_MAINTAINER_ID = 'user-1';
    const { client } = makeClient(() => {
      throw new Error('Cannot send messages to this user');
    });
    await expect(checkBggCatalogReminder(client)).resolves.not.toThrow();
    expect(writeJson).toHaveBeenCalledWith(
      'system_state.json',
      expect.objectContaining({ bggCatalogReminderSentAt: expect.any(String) }),
    );
  });
});
