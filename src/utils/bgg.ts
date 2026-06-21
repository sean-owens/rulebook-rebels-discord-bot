import https from 'https';
import { XMLParser } from 'fast-xml-parser';

export interface BGGSearchResult {
  id: string;
  name: string;
  yearPublished: number | null;
}

export interface BGGExpansion {
  id: string;
  name: string;
}

export interface BGGGame {
  id: string;
  name: string;
  bggLink: string;
  minPlayers: number;
  maxPlayers: number;
  suggestedPlayers: number;
  minPlaytime: number;
  maxPlaytime: number;
  thumbnail: string | null;
  expansions: BGGExpansion[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function bggHeaders(): Record<string, string> {
  const cookie = process.env.BGG_SESSION_COOKIE;
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/xml, text/xml, */*',
  };
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

function fetchXML(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: bggHeaders() }, res => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        res.resume();
        reject(new Error(`BGG returned ${res.statusCode} — session cookie may be missing or expired`));
        return;
      }
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchXML(res.headers.location));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export async function searchBGG(query: string): Promise<BGGSearchResult[]> {
  const url = `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`;
  const xml = await fetchXML(url);
  const parsed = parser.parse(xml);

  const raw = parsed?.items?.item ?? [];
  const items: any[] = Array.isArray(raw) ? raw : [raw];

  return items.slice(0, 5).map(item => {
    const names: any[] = Array.isArray(item.name) ? item.name : [item.name];
    const primary = names.find(n => n['@_type'] === 'primary');
    return {
      id: String(item['@_id']),
      name: primary?.['@_value'] ?? names[0]?.['@_value'] ?? 'Unknown',
      yearPublished: item.yearpublished?.['@_value'] ? Number(item.yearpublished['@_value']) : null,
    };
  });
}

export async function getBGGGame(id: string): Promise<BGGGame> {
  const url = `https://boardgamegeek.com/xmlapi2/thing?id=${id}&stats=1`;
  const xml = await fetchXML(url);
  const parsed = parser.parse(xml);

  const item = parsed?.items?.item;
  if (!item) throw new Error(`BGG game ${id} not found`);

  const names: any[] = Array.isArray(item.name) ? item.name : [item.name];
  const primaryName = names.find(n => n['@_type'] === 'primary')?.['@_value'] ?? 'Unknown';

  // Best player count from community poll
  const polls: any[] = Array.isArray(item.poll) ? item.poll : (item.poll ? [item.poll] : []);
  const numPlayersPoll = polls.find(p => p['@_name'] === 'suggested_numplayers');
  let suggestedPlayers = Number(item.minplayers?.['@_value'] ?? 2);

  if (numPlayersPoll?.results) {
    const results: any[] = Array.isArray(numPlayersPoll.results) ? numPlayersPoll.results : [numPlayersPoll.results];
    let bestVotes = 0;
    for (const result of results) {
      const numPlayers = String(result['@_numplayers'] ?? '');
      if (numPlayers.includes('+')) continue;
      const votes: any[] = Array.isArray(result.result) ? result.result : (result.result ? [result.result] : []);
      const best = votes.find(v => v['@_value'] === 'Best');
      const count = Number(best?.['@_numvotes'] ?? 0);
      if (count > bestVotes) {
        bestVotes = count;
        suggestedPlayers = Number(numPlayers);
      }
    }
  }

  // Expansions: outbound boardgameexpansion links (not inbound)
  const links: any[] = Array.isArray(item.link) ? item.link : (item.link ? [item.link] : []);
  const expansions: BGGExpansion[] = links
    .filter(l => l['@_type'] === 'boardgameexpansion' && !l['@_inbound'])
    .map(l => ({ id: String(l['@_id']), name: String(l['@_value']) }))
    .slice(0, 25);

  return {
    id,
    name: primaryName,
    bggLink: `https://boardgamegeek.com/boardgame/${id}`,
    minPlayers: Number(item.minplayers?.['@_value'] ?? 2),
    maxPlayers: Number(item.maxplayers?.['@_value'] ?? 4),
    suggestedPlayers,
    minPlaytime: Number(item.minplaytime?.['@_value'] ?? 30),
    maxPlaytime: Number(item.maxplaytime?.['@_value'] ?? 60),
    thumbnail: item.thumbnail ?? null,
    expansions,
  };
}
