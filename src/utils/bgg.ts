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
  weight: number | null;
  thumbnail: string | null;
  expansions: BGGExpansion[];
  tags: string[];
}

export function weightTag(weight: number): 'Light' | 'Medium' | 'Heavy' {
  if (weight <= 2.0) return 'Light';
  if (weight <= 3.5) return 'Medium';
  return 'Heavy';
}

// Maps lowercase BGG mechanic/category names to our curated tag vocabulary
export const BGG_TO_TAG: Record<string, string> = {
  'cooperative game': 'Co-op',
  'semi-cooperative game': 'Semi-Co-op',
  'team-based game': 'Team vs Team',
  'solo / solitaire game': 'Solo Friendly',
  'deck, bag, and pool building': 'Deck Building',
  'engine building': 'Engine Building',
  'worker placement': 'Worker Placement',
  'worker placement with dice workers': 'Worker Placement',
  'area majority / influence': 'Area Control',
  'territory building': 'Area Control',
  'tile placement': 'Tile Placement',
  'card drafting': 'Drafting',
  'auction/bidding': 'Auction',
  'auction: english': 'Auction',
  'auction: sealed bid': 'Auction',
  'trick-taking': 'Trick Taking',
  'push your luck': 'Push Your Luck',
  'roll and write': 'Roll & Write',
  'hand management': 'Hand Management',
  'social deduction': 'Social Deduction',
  'hidden roles': 'Hidden Roles',
  'bluffing': 'Bluffing',
  'abstract strategy': 'Abstract',
  'strategy': 'Strategy',
  'economic': 'Economic',
  'party game': 'Party',
  'dungeon crawler': 'Dungeon Crawler',
  'legacy game': 'Legacy',
  'family game': 'Gateway / Family',
  'miniatures': 'Miniatures'
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function bggHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/xml, text/xml, */*',
  };
  const cookie = process.env.BGG_SESSION_COOKIE;
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

async function fetchXML(url: string): Promise<string> {
  const res = await fetch(url, { headers: bggHeaders() });
  if (!res.ok) throw new Error(`BGG returned ${res.status} for ${url}`);
  return res.text();
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

  // Tags: map BGG categories and mechanics to our curated vocabulary
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const link of links) {
    const type: string = link['@_type'] ?? '';
    if (type !== 'boardgamecategory' && type !== 'boardgamemechanic') continue;
    const mapped = BGG_TO_TAG[String(link['@_value'] ?? '').toLowerCase()];
    if (mapped && !seen.has(mapped)) { seen.add(mapped); tags.push(mapped); }
    if (tags.length >= 5) break;
  }

  const rawWeight = item.statistics?.ratings?.averageweight?.['@_value'];
  const weight = rawWeight != null && Number(rawWeight) > 0 ? Number(rawWeight) : null;

  return {
    id,
    name: primaryName,
    bggLink: `https://boardgamegeek.com/boardgame/${id}`,
    minPlayers: Number(item.minplayers?.['@_value'] ?? 2),
    maxPlayers: Number(item.maxplayers?.['@_value'] ?? 4),
    suggestedPlayers,
    minPlaytime: Number(item.minplaytime?.['@_value'] ?? 30),
    maxPlaytime: Number(item.maxplaytime?.['@_value'] ?? 60),
    weight,
    thumbnail: item.thumbnail ?? null,
    expansions,
    tags,
  };
}
