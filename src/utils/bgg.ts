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
  parentGame?: BGGExpansion;
  // Combined categories+mechanics through BGG_TO_TAG's curated vocabulary —
  // this is the field the library-tagging system (game.ts/library.ts) reads;
  // don't repurpose it for the challenge's clues, which need category and
  // mechanic kept separate (see categories/mechanics below) to progress from
  // vague to specific across hints 1/2.
  tags: string[];
  // Same curated vocabulary as `tags`, split by BGG link type — categories
  // read as a "genre" (hint 1, vaguest), mechanics as gameplay systems
  // (hint 2, more specific). Used by generateClues (boardGameChallenge.ts) only.
  categories: string[];
  mechanics: string[];
  howToPlayUrl: string | null;
  yearPublished: number | null;
  designers: string[];
  publishers: string[];
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
  bluffing: 'Bluffing',
  'abstract strategy': 'Abstract',
  strategy: 'Strategy',
  economic: 'Economic',
  'party game': 'Party',
  'dungeon crawler': 'Dungeon Crawler',
  'legacy game': 'Legacy',
  'family game': 'Gateway / Family',
  miniatures: 'Miniatures',
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function bggHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/xml, text/xml, */*',
  };
  const apiKey = process.env.BGG_API_KEY;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const cookie = process.env.BGG_SESSION_COOKIE;
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

// BGG occasionally 403s (or 5xx's) a request that succeeds moments later —
// observed in production taking down an entire weekly challenge cycle,
// since nothing in this file retried a transient failure. 429 is a
// deliberate rate-limit signal (not a blip) and 404 is a real "not found",
// so neither is retried here.
const RETRYABLE_STATUSES = new Set([403, 500, 502, 503, 504]);
const MAX_FETCH_RETRIES = 2;
// The collection endpoint responds 202 while it builds a fresh export for
// an unsynced user, rather than any of the statuses above — same idea
// (try again shortly) but a separate BGG-specific contract, so it's opted
// into per call via `pollFor202` rather than folded into RETRYABLE_STATUSES.
const MAX_202_POLLS = 1;

// Opt-in verbose logging of every BGG request this file makes (URL, status,
// attempt number, elapsed time, and whether it's retrying, polling, or
// done). Off by default — a syncall of hundreds of games would otherwise
// flood production logs with routine 200s. Flip on in Railway's env vars
// when diagnosing a live BGG issue, e.g. the 403 that took down a challenge
// cycle (see RETRYABLE_STATUSES above) or a batch failing for an unclear
// reason.
function bggDebugLoggingEnabled(): boolean {
  return process.env.BGG_DEBUG_LOGGING === 'true';
}

function logBGGAttempt(message: string): void {
  if (bggDebugLoggingEnabled()) console.log(`[BGG debug] ${message}`);
}

// Shared GET wrapper for every BGG XMLAPI2 call in this file. Retries a
// transient-looking failure a couple of times with backoff, and — when
// `pollFor202` is set — also polls through the collection endpoint's 202.
// Returns the raw Response either way; callers still decide what a
// particular status (404, or a 202 that outlasted the poll budget) means
// for them, since that varies by endpoint (throw vs. null vs. []).
async function fetchBGGResponse(
  url: string,
  options: { headers?: Record<string, string>; pollFor202?: boolean } = {},
): Promise<Response> {
  const headers = { ...bggHeaders(), ...options.headers };
  for (let transientAttempt = 0, pollAttempt = 0; ; ) {
    const attemptNum = transientAttempt + pollAttempt + 1;
    const startedAt = Date.now();
    const res = await fetch(url, { headers });
    const elapsedMs = Date.now() - startedAt;
    if (options.pollFor202 && res.status === 202 && pollAttempt < MAX_202_POLLS) {
      logBGGAttempt(`attempt ${attemptNum} -> 202 (${elapsedMs}ms), polling again: ${url}`);
      pollAttempt++;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!res.ok && RETRYABLE_STATUSES.has(res.status) && transientAttempt < MAX_FETCH_RETRIES) {
      logBGGAttempt(`attempt ${attemptNum} -> ${res.status} (${elapsedMs}ms), retrying: ${url}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** transientAttempt));
      transientAttempt++;
      continue;
    }
    logBGGAttempt(
      `attempt ${attemptNum} -> ${res.status} (${elapsedMs}ms), ${res.ok ? 'success' : 'final failure'}: ${url}`,
    );
    return res;
  }
}

async function fetchXML(url: string): Promise<string> {
  const res = await fetchBGGResponse(url);
  if (!res.ok) throw new Error(`BGG returned ${res.status} for ${url}`);
  return res.text();
}

interface BGGVideoEntry {
  username: string;
  url: string;
  numRecommend: number;
}

async function fetchBGGVideos(bggId: string): Promise<BGGVideoEntry[]> {
  const url = `https://api.geekdo.com/api/videos?objectid=${bggId}&objecttype=thing&sort=hot&showcount=25&start=0&gallery=instructional`;
  const res = await fetchBGGResponse(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const json = await res.json() as { videos?: any[] };
  const videos: any[] = json.videos ?? [];
  return videos
    .filter((v) => v.videohost && v.extvideoid)
    .map((v) => ({
      username: String(v.user?.username ?? '').toLowerCase(),
      url: v.videohost === 'youtube'
        ? `https://www.youtube.com/watch?v=${v.extvideoid}`
        : `https://vimeo.com/${v.extvideoid}`,
      numRecommend: Number(v.numrecommend ?? 0),
    }));
}

// Discord select menus cap out at 25 options; we paginate the suggest-flow
// dropdown at 24 results per page (leaving room for the "enter manually"
// option), so keeping a couple of pages' worth covers "not in the first 10"
// without hanging on to an unbounded list for a very generic query.
const MAX_SEARCH_RESULTS = 50;

export async function searchBGG(query: string): Promise<BGGSearchResult[]> {
  const url = `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`;
  const xml = await fetchXML(url);
  const parsed = parser.parse(xml);

  const raw = parsed?.items?.item ?? [];
  const items: any[] = Array.isArray(raw) ? raw : [raw];

  const results = items.map((item) => {
    const names: any[] = Array.isArray(item.name) ? item.name : [item.name];
    const primary = names.find((n) => n['@_type'] === 'primary');
    return {
      id: String(item['@_id']),
      name: decodeEntities(primary?.['@_value'] ?? names[0]?.['@_value'] ?? 'Unknown'),
      yearPublished: item.yearpublished?.['@_value'] ? Number(item.yearpublished['@_value']) : null,
    };
  });

  // Newest first; unknown publish years sort last rather than first.
  results.sort((a, b) => (b.yearPublished ?? -Infinity) - (a.yearPublished ?? -Infinity));

  return results.slice(0, MAX_SEARCH_RESULTS);
}

export interface BGGUser {
  id: string;
  username: string;
}

export interface BGGCollectionGame {
  bggGameId: string;
  gameName: string;
  yearPublished: number | null;
  thumbnail: string | null;
  minPlayers: number | null;
  maxPlayers: number | null;
  minPlaytime: number | null;
  maxPlaytime: number | null;
  playingTime: number | null;
  avgRating: number | null;
  bggRank: number | null;
  own: boolean;
  forTrade: boolean;
  wantToPlay: boolean;
  wishlisted: boolean;
  userRating: number | null;
  numPlays: number;
  isExpansion?: boolean;
}

function decodeEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fetchCollectionPage(
  username: string,
  subtype: 'boardgame' | 'boardgameexpansion',
): Promise<BGGCollectionGame[] | null> {
  const url =
    subtype === 'boardgame'
      ? `https://boardgamegeek.com/xmlapi2/collection?username=${encodeURIComponent(username)}&own=1&subtype=boardgame&excludesubtype=boardgameexpansion&stats=1`
      : `https://boardgamegeek.com/xmlapi2/collection?username=${encodeURIComponent(username)}&own=1&subtype=boardgameexpansion&stats=1`;
  const res = await fetchBGGResponse(url, { pollFor202: true });
  if (res.status === 202) {
    console.log(`[BGG collection] still queued after retrying for ${url}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[BGG collection] HTTP ${res.status} for ${url}`);
    return null;
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const raw = parsed?.items?.item ?? [];
  const items: any[] = Array.isArray(raw) ? raw : [raw];

  return items
    .filter((item) => item['@_subtype'] === subtype)
    .map((item) => {
      const status = item.status ?? {};
      const stats = item.stats ?? {};
      const ratingVal = parseFloat(item.stats?.rating?.['@_value']);
      const avgVal = parseFloat(item.stats?.rating?.average?.['@_value']);
      const ranks: any[] = Array.isArray(stats.rating?.ranks?.rank)
        ? stats.rating.ranks.rank
        : stats.rating?.ranks?.rank
          ? [stats.rating.ranks.rank]
          : [];
      const overallRank = ranks.find((r) => r['@_name'] === 'boardgame');
      const rankVal = parseInt(overallRank?.['@_value'], 10);
      const rawName =
        typeof item.name === 'string'
          ? item.name
          : String(item.name?.['#text'] ?? item.name ?? '');

      return {
        bggGameId: String(item['@_objectid']),
        gameName: decodeEntities(rawName),
        yearPublished: parseInt(item.yearpublished, 10) || null,
        thumbnail: item.thumbnail ? `https:${item.thumbnail}` : null,
        minPlayers: parseInt(stats['@_minplayers'], 10) || null,
        maxPlayers: parseInt(stats['@_maxplayers'], 10) || null,
        minPlaytime: parseInt(stats['@_minplaytime'], 10) || null,
        maxPlaytime: parseInt(stats['@_maxplaytime'], 10) || null,
        playingTime: parseInt(stats['@_playingtime'], 10) || null,
        avgRating: isNaN(avgVal) ? null : Math.round(avgVal * 10) / 10,
        bggRank: isNaN(rankVal) ? null : rankVal,
        own: status['@_own'] === 1 || status['@_own'] === '1',
        forTrade: status['@_fortrade'] === 1 || status['@_fortrade'] === '1',
        wantToPlay: status['@_wanttoplay'] === 1 || status['@_wanttoplay'] === '1',
        wishlisted: status['@_wishlistitem'] === 1 || status['@_wishlistitem'] === '1',
        userRating: isNaN(ratingVal) ? null : ratingVal,
        numPlays: parseInt(item.numplays, 10) || 0,
        isExpansion: subtype === 'boardgameexpansion',
      };
    });
}

export async function fetchBggOwnedCollection(
  username: string,
): Promise<BGGCollectionGame[] | null> {
  try {
    const baseGames = await fetchCollectionPage(username, 'boardgame');
    if (!baseGames) return null;
    const expansions = await fetchCollectionPage(username, 'boardgameexpansion');
    return [...baseGames, ...(expansions ?? [])];
  } catch (err) {
    console.error('[BGG collection] fetchCollectionPage threw:', err);
    return null;
  }
}

export interface BGGUserProfile {
  username: string;
  memberSince: string | null;
  baseGames: number | null;
  expansions: number | null;
  topGames: { rank: number; name: string }[];
}

async function fetchCollectionCount(
  username: string,
  subtype: 'boardgame' | 'boardgameexpansion',
): Promise<number | null> {
  const url =
    subtype === 'boardgame'
      ? `https://boardgamegeek.com/xmlapi2/collection?username=${encodeURIComponent(username)}&own=1&subtype=boardgame&excludesubtype=boardgameexpansion`
      : `https://boardgamegeek.com/xmlapi2/collection?username=${encodeURIComponent(username)}&own=1&subtype=boardgameexpansion`;
  const res = await fetchBGGResponse(url, { pollFor202: true });
  if (res.status === 202 || !res.ok) return null; // 202 here means it outlasted the poll budget
  const xml = await res.text();
  const parsed = parser.parse(xml);
  return parseInt(parsed?.items?.['@_totalitems'] ?? '0', 10) || 0;
}

export async function getBggUserProfile(username: string): Promise<BGGUserProfile | null> {
  const userUrl = `https://boardgamegeek.com/xmlapi2/user?name=${encodeURIComponent(username)}&top=1`;

  const [userRes, baseGames, expansions] = await Promise.all([
    fetchBGGResponse(userUrl),
    fetchCollectionCount(username, 'boardgame'),
    fetchCollectionCount(username, 'boardgameexpansion'),
  ]);

  if (userRes.status === 404) return null;
  if (!userRes.ok) throw new Error(`BGG returned ${userRes.status} for ${userUrl}`);

  const xml = await userRes.text();
  const parsed = parser.parse(xml);
  const user = parsed?.user;
  if (!user || String(user['@_id'] ?? '0') === '0') return null;

  const memberSince = user.yearregistered?.['@_value']
    ? String(user.yearregistered['@_value'])
    : null;

  const rawTop = user.top?.item ?? [];
  const topItems: any[] = Array.isArray(rawTop) ? rawTop : [rawTop];
  const topGames = topItems
    .filter((i) => i?.['@_name'])
    .map((i) => ({ rank: Number(i['@_rank']), name: String(i['@_name']) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5);

  return {
    username: String(user['@_name'] ?? username),
    memberSince,
    baseGames,
    expansions,
    topGames,
  };
}

const pendingUserValidations = new Map<string, Promise<BGGUser | null>>();

export async function validateBggUser(username: string): Promise<BGGUser | null> {
  const key = username.toLowerCase();
  const inflight = pendingUserValidations.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const url = `https://boardgamegeek.com/xmlapi2/user?name=${encodeURIComponent(username)}`;
      const res = await fetchBGGResponse(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`BGG returned ${res.status} for ${url}`);
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const user = parsed?.user;
      const id = String(user?.['@_id'] ?? '0');
      if (!user || id === '0') return null;
      return { id, username: String(user['@_name'] ?? username) };
    } finally {
      pendingUserValidations.delete(key);
    }
  })();

  pendingUserValidations.set(key, promise);
  return promise;
}

function parseBGGItem(item: any, id: string): Omit<BGGGame, 'howToPlayUrl'> {
  const names: any[] = Array.isArray(item.name) ? item.name : [item.name];
  const primaryName = decodeEntities(names.find((n) => n['@_type'] === 'primary')?.['@_value'] ?? 'Unknown');

  const polls: any[] = Array.isArray(item.poll) ? item.poll : item.poll ? [item.poll] : [];
  const numPlayersPoll = polls.find((p) => p['@_name'] === 'suggested_numplayers');
  let suggestedPlayers = Number(item.minplayers?.['@_value'] ?? 2);

  if (numPlayersPoll?.results) {
    const results: any[] = Array.isArray(numPlayersPoll.results)
      ? numPlayersPoll.results
      : [numPlayersPoll.results];
    let bestVotes = 0;
    for (const result of results) {
      const numPlayers = String(result['@_numplayers'] ?? '');
      if (numPlayers.includes('+')) continue;
      const votes: any[] = Array.isArray(result.result)
        ? result.result
        : result.result
          ? [result.result]
          : [];
      const best = votes.find((v) => v['@_value'] === 'Best');
      const count = Number(best?.['@_numvotes'] ?? 0);
      if (count > bestVotes) {
        bestVotes = count;
        suggestedPlayers = Number(numPlayers);
      }
    }
  }

  const links: any[] = Array.isArray(item.link) ? item.link : item.link ? [item.link] : [];
  const expansions: BGGExpansion[] = links
    .filter((l) => l['@_type'] === 'boardgameexpansion' && !l['@_inbound'])
    .map((l) => ({ id: String(l['@_id']), name: decodeEntities(String(l['@_value'])) }))
    .slice(0, 25);

  const parentGame: BGGExpansion | undefined = links
    .filter((l) => l['@_type'] === 'boardgameexpansion' && l['@_inbound'])
    .map((l) => ({ id: String(l['@_id']), name: decodeEntities(String(l['@_value'])) }))[0];

  // `tags` maps through BGG_TO_TAG's small curated vocabulary — deliberately
  // narrow, since it's read by the library-tagging system as a fixed set of
  // member-facing preference tags. `categories`/`mechanics` are the raw BGG
  // category/mechanic names instead (same plain filter+map+slice pattern as
  // designers/publishers below) — using the curated vocabulary here too
  // would leave "genre" blank for most games, since BGG_TO_TAG only covers a
  // handful of the dozens of real BGG category names (e.g. "Fantasy",
  // "Card Game", "Exploration" have no entry) and was never meant to be
  // exhaustive. See generateClues in boardGameChallenge.ts.
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const link of links) {
    const type: string = link['@_type'] ?? '';
    if (type !== 'boardgamecategory' && type !== 'boardgamemechanic') continue;
    const mapped = BGG_TO_TAG[String(link['@_value'] ?? '').toLowerCase()];
    if (mapped && !seen.has(mapped)) {
      seen.add(mapped);
      if (tags.length < 5) tags.push(mapped);
    }
  }
  const categories = links
    .filter((l) => l['@_type'] === 'boardgamecategory')
    .map((l) => decodeEntities(String(l['@_value'])))
    .slice(0, 3);
  const mechanics = links
    .filter((l) => l['@_type'] === 'boardgamemechanic')
    .map((l) => decodeEntities(String(l['@_value'])))
    .slice(0, 3);

  const rawWeight = item.statistics?.ratings?.averageweight?.['@_value'];
  const weight = rawWeight != null && Number(rawWeight) > 0 ? Number(rawWeight) : null;

  const rawYear = item.yearpublished?.['@_value'];
  const yearPublished = rawYear != null && Number(rawYear) > 0 ? Number(rawYear) : null;

  const designers = links
    .filter((l) => l['@_type'] === 'boardgamedesigner')
    .map((l) => decodeEntities(String(l['@_value'])))
    .slice(0, 5);

  const publishers = links
    .filter((l) => l['@_type'] === 'boardgamepublisher')
    .map((l) => decodeEntities(String(l['@_value'])))
    .slice(0, 5);

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
    thumbnail: item.thumbnail
      ? String(item.thumbnail).startsWith('//')
        ? `https:${item.thumbnail}`
        : String(item.thumbnail)
      : null,
    expansions,
    parentGame,
    tags,
    categories,
    mechanics,
    yearPublished,
    designers,
    publishers,
  };
}

async function fetchHowToPlayUrl(id: string, name: string): Promise<string | null> {
  try {
    const videos = await fetchBGGVideos(id);
    return videos[0]?.url ?? null;
  } catch {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `https://boardgamegeek.com/boardgame/${id}/${slug}/videos/instructional?sort=hot`;
  }
}

export async function getBGGGame(id: string): Promise<BGGGame> {
  const url = `https://boardgamegeek.com/xmlapi2/thing?id=${id}&stats=1`;
  const xml = await fetchXML(url);
  const parsed = parser.parse(xml);

  const item = parsed?.items?.item;
  if (!item) throw new Error(`BGG game ${id} not found`);

  const gameData = parseBGGItem(item, id);
  const howToPlayUrl = await fetchHowToPlayUrl(id, gameData.name);

  return { ...gameData, howToPlayUrl };
}

// Batch fetch up to 20 games in a single XMLAPI2 call, then fetch videos individually.
// videoDelayMs is the pause between each geekdo video API call.
export interface BGGMarketplacePrice {
  currency: string;
  value: number;
  condition: string;
  listDate: string;
}

export interface BGGMarketplaceSummary {
  listings: BGGMarketplacePrice[];
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  currency: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export async function fetchBGGMarketplacePrices(bggId: string): Promise<BGGMarketplaceSummary | null> {
  try {
    const url = `https://boardgamegeek.com/xmlapi2/thing?id=${bggId}&marketplace=1`;
    const xml = await fetchXML(url);
    const parsed = parser.parse(xml);
    const item = parsed?.items?.item;
    if (!item) return null;

    const rawListings = item.marketplacelistings?.listing ?? [];
    const listingsArr: any[] = Array.isArray(rawListings) ? rawListings : [rawListings];

    const usdListings = listingsArr.filter(
      (l) => l?.price?.['@_currency'] === 'USD' && l?.price?.['@_value'],
    );

    const prices: BGGMarketplacePrice[] = usdListings.map((l) => ({
      currency: 'USD',
      value: parseFloat(l.price['@_value']),
      condition: String(l.condition?.['@_value'] ?? 'unknown'),
      listDate: String(l.listdate?.['@_value'] ?? ''),
    }));

    if (prices.length === 0) return { listings: [], avgPrice: null, minPrice: null, maxPrice: null, p25: null, p50: null, p75: null, currency: 'USD' };

    const values = prices.map((p) => p.value).sort((a, b) => a - b);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;

    return {
      listings: prices,
      avgPrice: Math.round(avg * 100) / 100,
      minPrice: values[0],
      maxPrice: values[values.length - 1],
      p25: Math.round(percentile(values, 25) * 100) / 100,
      p50: Math.round(percentile(values, 50) * 100) / 100,
      p75: Math.round(percentile(values, 75) * 100) / 100,
      currency: 'USD',
    };
  } catch {
    return null;
  }
}

export interface BGGMarketplaceCollectionGame {
  bggGameId: string;
  gameName: string;
  thumbnail: string | null;
  yearPublished: number | null;
  forSale: boolean;
  forTrade: boolean;
}

export async function fetchBGGMarketplaceCollection(
  username: string,
): Promise<BGGMarketplaceCollectionGame[] | null> {
  const fetchPage = async (flag: 'forsale' | 'fortrade'): Promise<BGGMarketplaceCollectionGame[]> => {
    const url = `https://boardgamegeek.com/xmlapi2/collection?username=${encodeURIComponent(username)}&${flag}=1&subtype=boardgame`;
    const res = await fetchBGGResponse(url, { pollFor202: true });
    if (res.status === 202 || !res.ok) return [];
    const xml = await res.text();
    const parsed = parser.parse(xml);
    const raw = parsed?.items?.item ?? [];
    const items: any[] = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => {
      const rawName =
        typeof item.name === 'string'
          ? item.name
          : String(item.name?.['#text'] ?? item.name ?? '');
      const status = item.status ?? {};
      const forsaleAttr = status['@_forsale'];
      const fortradeAttr = status['@_fortrade'];
      // Use per-item status attributes when present; fall back to trusting the filter parameter
      const forSale = forsaleAttr !== undefined
        ? (forsaleAttr === 1 || forsaleAttr === '1')
        : flag === 'forsale';
      const forTrade = fortradeAttr !== undefined
        ? (fortradeAttr === 1 || fortradeAttr === '1')
        : flag === 'fortrade';
      return {
        bggGameId: String(item['@_objectid']),
        gameName: decodeEntities(rawName),
        thumbnail: item.thumbnail ? `https:${item.thumbnail}` : null,
        yearPublished: parseInt(item.yearpublished, 10) || null,
        forSale,
        forTrade,
      };
    }).filter((item) => item.forSale || item.forTrade);
  };

  try {
    const [forSale, forTrade] = await Promise.all([
      fetchPage('forsale'),
      fetchPage('fortrade'),
    ]);

    const seen = new Set<string>();
    const combined: BGGMarketplaceCollectionGame[] = [];
    for (const game of [...forSale, ...forTrade]) {
      if (!seen.has(game.bggGameId)) {
        seen.add(game.bggGameId);
        combined.push(game);
      } else {
        const existing = combined.find((g) => g.bggGameId === game.bggGameId);
        if (existing) {
          existing.forSale = existing.forSale || game.forSale;
          existing.forTrade = existing.forTrade || game.forTrade;
        }
      }
    }
    return combined;
  } catch (err) {
    console.error('[BGG marketplace collection] error:', err);
    return null;
  }
}

export async function getBGGGamesBatch(ids: string[], videoDelayMs = 500): Promise<BGGGame[]> {
  if (ids.length === 0) return [];
  const url = `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(',')}&stats=1`;
  const xml = await fetchXML(url);
  const parsed = parser.parse(xml);
  const rawItems = parsed?.items?.item;
  const items: any[] = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  const results: BGGGame[] = [];
  for (const item of items) {
    if (results.length > 0) await new Promise((r) => setTimeout(r, videoDelayMs));
    const id = String(item['@_id']);
    const gameData = parseBGGItem(item, id);
    const howToPlayUrl = await fetchHowToPlayUrl(id, gameData.name);
    results.push({ ...gameData, howToPlayUrl });
  }
  return results;
}
