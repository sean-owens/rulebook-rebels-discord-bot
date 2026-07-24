import http from 'http';
import { findShortLink, recordShortLinkOpen } from './shortLinkStorage';

const CODE_PATTERN = /^\/s\/([A-Za-z0-9_-]+)$/;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${extraHead}<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #2b2d31; color: #f2f3f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
  .card { max-width: 360px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #b5bac1; font-size: 14px; margin: 0 0 24px; }
  a.button { display: inline-block; background: #e8a838; color: #1e1f22; font-weight: 600; padding: 12px 24px; border-radius: 8px; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

// Re-added after the "opens then closes" reports turned out to be caused by
// a payload bug (game.bggId sent as a string instead of the number BG Stats'
// schema expects — see bgStats.ts), not this auto-forward. A short pause
// still gives the manual button a beat to be readable; the delay is kept
// brief since the previous 3s version was implicated (rightly or not) in the
// original report — watch for the same symptom recurring on iOS specifically,
// since Apple's universal-link activation is documented to require a genuine
// tap, not a timed/automatic redirect like this one.
const AUTO_FORWARD_DELAY_SECONDS = 2;

function renderLandingPage(url: string): string {
  const safeUrl = escapeHtml(url);
  return page(
    'Log this play in BG Stats',
    `<h1>📊 Log this play in BG Stats</h1>
    <p>Redirecting you to BG Stats with this game, location, and players already filled in — tap below if it doesn't happen automatically.</p>
    <a class="button" href="${safeUrl}">Open BG Stats</a>`,
    `<meta http-equiv="refresh" content="${AUTO_FORWARD_DELAY_SECONDS};url=${safeUrl}">\n`,
  );
}

function renderNotFoundPage(): string {
  return page(
    'Link not found',
    `<h1>Link not found</h1>
    <p>This BG Stats link has expired or doesn't exist. Head back to Discord and generate a new one with <code>/game bgstats</code>.</p>`,
  );
}

/**
 * Tiny redirect service backing the BG Stats "Log in BG Stats" button (see
 * src/utils/bgStats.ts). Serves a small landing page describing what's about
 * to happen rather than redirecting silently — a real tap is also more
 * reliable than an automatic redirect for opening universal links on mobile.
 * Only ever links to URLs this bot generated and stored itself via a random
 * short code — it never accepts or reflects a caller-supplied redirect
 * target, so it can't be used as an open redirect.
 */
export function startShortLinkServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }

    const match = req.url?.match(CODE_PATTERN);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderNotFoundPage());
      return;
    }

    try {
      const link = await findShortLink(match[1]);
      if (!link) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderNotFoundPage());
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderLandingPage(link.url));
      recordShortLinkOpen(link.code).catch((err) =>
        console.warn('[ShortLinkServer] Failed to record open:', err),
      );
    } catch (err) {
      console.warn('[ShortLinkServer] Error resolving short link:', err);
      res.writeHead(500).end();
    }
  });

  server.listen(port, () => console.log(`[ShortLinkServer] Listening on port ${port}`));
  return server;
}
