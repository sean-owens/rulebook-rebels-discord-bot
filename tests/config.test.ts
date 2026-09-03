import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getGuildConfig, updateGuildConfig } from '../src/utils/config';

describe('getGuildConfig defaults', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-config-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults a brand-new guild to the "Events" category name', async () => {
    const config = await getGuildConfig('new-guild-1');
    expect(config.eventCategoryName).toBe('Events');
  });

  it('defaults a brand-new guild to private marketplace negotiation', async () => {
    const config = await getGuildConfig('new-guild-1');
    expect(config.marketplaceNegotiationMode).toBe('private');
  });

  it('defaults a brand-new guild to UTC until a timezone is explicitly set', async () => {
    const config = await getGuildConfig('new-guild-1');
    expect(config.timezone).toBe('UTC');
  });

  it('persists an explicit override and leaves other defaults untouched', async () => {
    await updateGuildConfig('guild-2', { eventCategoryName: 'Board Game Nights' });
    const config = await getGuildConfig('guild-2');
    expect(config.eventCategoryName).toBe('Board Game Nights');
    expect(config.marketplaceNegotiationMode).toBe('private');
  });
});
