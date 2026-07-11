import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { startShortLinkServer } from '../src/utils/shortLinkServer';
import { createShortLink } from '../src/utils/shortLinkStorage';

function get(port: number, urlPath: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        res.resume(); // drain body
        resolve({ status: res.statusCode!, location: res.headers.location });
      })
      .on('error', reject);
  });
}

function getPort(server: http.Server): number {
  const address = server.address();
  if (typeof address === 'object' && address) return address.port;
  throw new Error('Server has no address');
}

describe('shortLinkServer', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-shortlinkserver-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('302-redirects to the stored URL for a known code', async () => {
    const link = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=abc');
    server = startShortLinkServer(0);
    const port = getPort(server);

    const res = await get(port, `/s/${link.code}`);
    expect(res.status).toBe(302);
    expect(res.location).toBe(link.url);
  });

  it('returns 404 for an unknown code', async () => {
    server = startShortLinkServer(0);
    const port = getPort(server);

    const res = await get(port, '/s/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 404 for any path that is not /s/<code>', async () => {
    server = startShortLinkServer(0);
    const port = getPort(server);

    const res = await get(port, '/');
    expect(res.status).toBe(404);
  });
});
