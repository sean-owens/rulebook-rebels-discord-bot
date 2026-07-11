import http from 'http';
import { findShortLink } from './shortLinkStorage';

const CODE_PATTERN = /^\/s\/([A-Za-z0-9_-]+)$/;

/**
 * Tiny redirect service backing the BG Stats "Log in BG Stats" button (see
 * src/utils/bgStats.ts). Only ever redirects to URLs this bot generated and
 * stored itself via a random short code — it never accepts or reflects a
 * caller-supplied redirect target, so it can't be used as an open redirect.
 */
export function startShortLinkServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }

    const match = req.url?.match(CODE_PATTERN);
    if (!match) {
      res.writeHead(404).end();
      return;
    }

    try {
      const link = await findShortLink(match[1]);
      if (!link) {
        res.writeHead(404).end('Link not found or expired');
        return;
      }
      res.writeHead(302, { Location: link.url }).end();
    } catch (err) {
      console.warn('[ShortLinkServer] Error resolving short link:', err);
      res.writeHead(500).end();
    }
  });

  server.listen(port, () => console.log(`[ShortLinkServer] Listening on port ${port}`));
  return server;
}
