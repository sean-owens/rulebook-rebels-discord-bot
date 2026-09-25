import { describe, it, expect, afterEach, vi } from 'vitest';
import { bggHeaders, BGG_USER_AGENT } from '../src/utils/bgg';

afterEach(() => vi.unstubAllEnvs());

describe('bggHeaders', () => {
  // Regression for issue #78: a spoofed browser User-Agent from a Node client
  // trips Cloudflare's bot management (403 "Just a moment…"), while an honest
  // one is served normally.
  it('identifies the bot honestly instead of impersonating a browser', () => {
    const ua = bggHeaders()['User-Agent'];
    expect(ua).toBe(BGG_USER_AGENT);
    expect(ua).toContain('RulebookRebelsBot');
    for (const browserToken of ['Mozilla', 'Chrome', 'Safari', 'AppleWebKit', 'Gecko']) {
      expect(ua).not.toContain(browserToken);
    }
  });

  it('asks for XML', () => {
    expect(bggHeaders().Accept).toBe('application/xml');
  });

  it('sends the API token as a bearer Authorization header when configured', () => {
    vi.stubEnv('BGG_API_KEY', 'secret-token');
    expect(bggHeaders().Authorization).toBe('Bearer secret-token');
  });

  it('omits Authorization and Cookie when neither is configured', () => {
    vi.stubEnv('BGG_API_KEY', '');
    vi.stubEnv('BGG_SESSION_COOKIE', '');
    const headers = bggHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
  });

  it('passes a session cookie through when configured', () => {
    vi.stubEnv('BGG_SESSION_COOKIE', 'SessionID=abc');
    expect(bggHeaders().Cookie).toBe('SessionID=abc');
  });
});
