import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { startShortLinkServer } from '../src/utils/shortLinkServer';
import { createShortLink } from '../src/utils/shortLinkStorage';

function get(port: number, urlPath: string): Promise<{ status: number; contentType?: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode!, contentType: res.headers['content-type'], body }),
        );
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

  it('serves a landing page linking to the stored URL for a known code', async () => {
    const link = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=abc');
    server = startShortLinkServer(0);
    const port = getPort(server);

    const res = await get(port, `/s/${link.code}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('BG Stats');
    expect(res.body).toContain(`href="${link.url}"`);
  });

  it('HTML-escapes the destination URL to avoid injecting markup', async () => {
    const link = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=a&b="x"');
    server = startShortLinkServer(0);
    const port = getPort(server);

    const res = await get(port, `/s/${link.code}`);
    expect(res.body).not.toContain('data=a&b="x"');
    expect(res.body).toContain('data=a&amp;b=&quot;x&quot;');
  });

  it('returns a 404 landing page for an unknown code', async () => {
    server = startShortLinkServer(0);
    const port = getPort(server);

    const res = await get(port, '/s/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('not found');
  });

  it('returns 404 for any path that is not /s/<code>', async () => {
    server = startShortLinkServer(0);
    const port = getPort(server);

    const res = await get(port, '/');
    expect(res.status).toBe(404);
  });
});
