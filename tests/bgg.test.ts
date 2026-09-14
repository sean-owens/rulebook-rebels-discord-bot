import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BGG_TO_TAG,
  searchBGG,
  getBGGGame,
  validateBggUser,
  getBggUserProfile,
  fetchBggOwnedCollection,
} from '../src/utils/bgg';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(xml: string, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(xml),
    }),
  );
}

// ── BGG_TO_TAG ────────────────────────────────────────────────────────────────

describe('BGG_TO_TAG', () => {
  it('maps cooperative game to Co-op', () => {
    expect(BGG_TO_TAG['cooperative game']).toBe('Co-op');
  });

  it('maps trick-taking to Trick Taking', () => {
    expect(BGG_TO_TAG['trick-taking']).toBe('Trick Taking');
  });

  it('maps worker placement variants to Worker Placement', () => {
    expect(BGG_TO_TAG['worker placement']).toBe('Worker Placement');
    expect(BGG_TO_TAG['worker placement with dice workers']).toBe('Worker Placement');
  });

  it('maps area control variants to Area Control', () => {
    expect(BGG_TO_TAG['area majority / influence']).toBe('Area Control');
    expect(BGG_TO_TAG['territory building']).toBe('Area Control');
  });

  it('maps auction variants to Auction', () => {
    expect(BGG_TO_TAG['auction/bidding']).toBe('Auction');
    expect(BGG_TO_TAG['auction: english']).toBe('Auction');
    expect(BGG_TO_TAG['auction: sealed bid']).toBe('Auction');
  });

  it('maps party game to Party', () => {
    expect(BGG_TO_TAG['party game']).toBe('Party');
  });

  it('maps family game to Gateway / Family', () => {
    expect(BGG_TO_TAG['family game']).toBe('Gateway / Family');
  });
});

// ── searchBGG ─────────────────────────────────────────────────────────────────

describe('searchBGG', () => {
  it('returns parsed results from the BGG search API, newest publish year first', async () => {
    mockFetch(`<?xml version="1.0" encoding="utf-8"?>
<items total="2">
  <item type="boardgame" id="167791">
    <name type="primary" sortindex="1" value="Terraforming Mars"/>
    <yearpublished value="2016"/>
  </item>
  <item type="boardgame" id="99999">
    <name type="primary" sortindex="1" value="Another Game"/>
    <yearpublished value="2020"/>
  </item>
</items>`);

    const results = await searchBGG('Terraforming Mars');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: '99999', name: 'Another Game', yearPublished: 2020 });
    expect(results[1]).toEqual({ id: '167791', name: 'Terraforming Mars', yearPublished: 2016 });
  });

  it('sorts results with an unknown publish year to the end', async () => {
    mockFetch(`<items total="2">
  <item type="boardgame" id="1">
    <name type="primary" value="No Year Game"/>
  </item>
  <item type="boardgame" id="2">
    <name type="primary" value="Old Game"/>
    <yearpublished value="1995"/>
  </item>
</items>`);

    const results = await searchBGG('game');
    expect(results.map((r) => r.id)).toEqual(['2', '1']);
  });

  it('returns at most 50 results', async () => {
    const items = Array.from(
      { length: 75 },
      (_, i) => `
  <item type="boardgame" id="${i}">
    <name type="primary" value="Game ${i}"/>
    <yearpublished value="${2000 + i}"/>
  </item>`,
    ).join('');
    mockFetch(`<items total="75">${items}</items>`);

    const results = await searchBGG('game');
    expect(results).toHaveLength(50);
    // Still the newest 50, not just the first 50 in document order.
    expect(results[0].yearPublished).toBe(2074);
    expect(results[49].yearPublished).toBe(2025);
  });

  it('handles a single result (non-array XML) correctly', async () => {
    mockFetch(`<items total="1">
  <item type="boardgame" id="42">
    <name type="primary" value="Solo Game"/>
  </item>
</items>`);

    const results = await searchBGG('solo');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('42');
  });

  it('returns an empty array when the API returns no items', async () => {
    mockFetch(`<items total="0"></items>`);
    const results = await searchBGG('xyzzy');
    expect(results).toHaveLength(0);
  });

  it('throws immediately on 429 without retrying (rate-limit signal, not a blip)', async () => {
    mockFetch('', 429);
    await expect(searchBGG('test')).rejects.toThrow('429');
  });

  it('decodes HTML entities in game names', async () => {
    mockFetch(`<items total="1">
  <item type="boardgame" id="313103">
    <name type="primary" value="Star Trek: Captain&#039;s Chair"/>
  </item>
</items>`);

    const results = await searchBGG("Star Trek Captain's Chair");
    expect(results[0].name).toBe("Star Trek: Captain's Chair");
  });
});

// ── getBGGGame ────────────────────────────────────────────────────────────────

describe('getBGGGame', () => {
  const WINGSPAN_XML = `<?xml version="1.0" encoding="utf-8"?>
<items>
  <item type="boardgame" id="266192">
    <thumbnail>https://example.com/thumb.jpg</thumbnail>
    <name type="primary" sortindex="1" value="Wingspan"/>
    <name type="alternate" sortindex="1" value="Flügelschlag"/>
    <minplayers value="1"/>
    <maxplayers value="5"/>
    <minplaytime value="40"/>
    <maxplaytime value="70"/>
    <link type="boardgamecategory" id="1029" value="Economic"/>
    <link type="boardgamemechanic" id="2664" value="Engine Building"/>
    <link type="boardgamemechanic" id="2081" value="Hand Management"/>
    <link type="boardgamedesigner" id="1" value="Elizabeth Hargrave"/>
    <link type="boardgamepublisher" id="2" value="Stonemaier Games"/>
    <link type="boardgamepublisher" id="3" value="Feuerland Spiele"/>
    <link type="boardgameexpansion" id="300837" value="Wingspan: European Expansion"/>
    <link type="boardgameexpansion" id="300838" value="Wingspan: Oceania Expansion"/>
    <poll name="suggested_numplayers" title="User Suggested: # of Players" totalvotes="500">
      <results numplayers="1">
        <result value="Best" numvotes="10"/>
      </results>
      <results numplayers="2">
        <result value="Best" numvotes="50"/>
      </results>
      <results numplayers="3">
        <result value="Best" numvotes="200"/>
      </results>
      <results numplayers="4">
        <result value="Best" numvotes="150"/>
      </results>
      <results numplayers="5">
        <result value="Best" numvotes="90"/>
      </results>
    </poll>
  </item>
</items>`;

  it('extracts the primary name', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.name).toBe('Wingspan');
  });

  it('extracts player counts', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.minPlayers).toBe(1);
    expect(game.maxPlayers).toBe(5);
  });

  it('extracts play time', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.minPlaytime).toBe(40);
    expect(game.maxPlaytime).toBe(70);
  });

  it('maps BGG categories/mechanics to internal tags', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.tags).toContain('Economic');
    expect(game.tags).toContain('Engine Building');
    expect(game.tags).toContain('Hand Management');
  });

  it('also splits categories and mechanics into their own fields (used by the weekly challenge clues)', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.categories).toEqual(['Economic']);
    expect(game.mechanics).toEqual(['Engine Building', 'Hand Management']);
  });

  // Regression: categories/mechanics previously only populated for the small
  // set of BGG names BGG_TO_TAG happens to curate for the library-tagging
  // system — most real BGG category names (e.g. "Fantasy", "Card Game",
  // below) have no entry there at all, so genre was blank for most games.
  it('includes raw BGG category/mechanic names with no entry in the curated tag vocabulary', async () => {
    mockFetch(`<?xml version="1.0" encoding="utf-8"?>
<items>
  <item type="boardgame" id="999">
    <name type="primary" sortindex="1" value="Untagged Game"/>
    <minplayers value="2"/>
    <maxplayers value="4"/>
    <minplaytime value="30"/>
    <maxplaytime value="60"/>
    <link type="boardgamecategory" id="1" value="Fantasy"/>
    <link type="boardgamecategory" id="2" value="Card Game"/>
    <link type="boardgamemechanic" id="3" value="Dice Rolling"/>
  </item>
</items>`);
    const game = await getBGGGame('999');
    expect(game.categories).toEqual(['Fantasy', 'Card Game']);
    expect(game.mechanics).toEqual(['Dice Rolling']);
    // None of these map through BGG_TO_TAG, so the curated `tags` field stays empty.
    expect(game.tags).toEqual([]);
  });

  it('extracts designers', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.designers).toEqual(['Elizabeth Hargrave']);
  });

  it('extracts publishers', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.publishers).toEqual(['Stonemaier Games', 'Feuerland Spiele']);
  });

  it('extracts outbound expansion links', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.expansions).toHaveLength(2);
    expect(game.expansions[0].name).toBe('Wingspan: European Expansion');
  });

  it('picks the player count with the most "Best" votes', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.suggestedPlayers).toBe(3); // 200 best votes
  });

  it('sets the BGG link correctly', async () => {
    mockFetch(WINGSPAN_XML);
    const game = await getBGGGame('266192');
    expect(game.bggLink).toBe('https://boardgamegeek.com/boardgame/266192');
  });

  it('throws immediately on 404 without retrying (real not-found, not a blip)', async () => {
    mockFetch('', 404);
    await expect(getBGGGame('0')).rejects.toThrow('404');
  });

  it('retries a transient 403 and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, text: () => Promise.resolve('') })
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(WINGSPAN_XML) });
    vi.stubGlobal('fetch', fetchMock);

    const promise = getBGGGame('266192');
    await vi.runAllTimersAsync();
    const game = await promise;
    expect(game.name).toBe('Wingspan');
    const thingCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('xmlapi2/thing'));
    expect(thingCalls).toHaveLength(2);
    vi.useRealTimers();
  });

  it('gives up after repeated 403s and throws', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('') }),
    );

    const promise = getBGGGame('266192');
    const expectation = expect(promise).rejects.toThrow('403');
    await vi.runAllTimersAsync();
    await expectation;
    vi.useRealTimers();
  });

  it('decodes HTML entities in the primary name and expansion names', async () => {
    mockFetch(`<?xml version="1.0" encoding="utf-8"?>
<items>
  <item type="boardgame" id="313103">
    <name type="primary" sortindex="1" value="Star Trek: Captain&#039;s Chair"/>
    <minplayers value="2"/>
    <maxplayers value="7"/>
    <minplaytime value="30"/>
    <maxplaytime value="60"/>
    <link type="boardgameexpansion" id="1" value="Captain&#039;s Chair: Away Team &amp; Beyond"/>
  </item>
</items>`);
    const game = await getBGGGame('313103');
    expect(game.name).toBe("Star Trek: Captain's Chair");
    expect(game.expansions[0].name).toBe("Captain's Chair: Away Team & Beyond");
  });
});

// ── validateBggUser ───────────────────────────────────────────────────────────

describe('validateBggUser', () => {
  const VALID_USER_XML = `<?xml version="1.0" encoding="utf-8"?>
<user id="12345" name="boardgamefan" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <firstname value="Board" />
  <lastname value="Fan" />
  <avatarlink value="N/A" />
  <yearregistered value="2010" />
  <lastlogin value="2024-01-01" />
  <stateorprovince value="" />
  <country value="United States" />
  <webaddress value="" />
  <xboxaccount value="" />
  <wiiaccount value="" />
  <psnaccount value="" />
  <battlenetaccount value="" />
  <steamaccount value="" />
  <traderating value="0" />
</user>`;

  const NOT_FOUND_XML = `<?xml version="1.0" encoding="utf-8"?>
<user id="0" name="" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
</user>`;

  it('returns user info for a valid username', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(VALID_USER_XML),
      }),
    );
    const result = await validateBggUser('boardgamefan');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('12345');
    expect(result?.username).toBe('boardgamefan');
  });

  it('returns null for an unknown username (id=0 in response)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(NOT_FOUND_XML),
      }),
    );
    const result = await validateBggUser('nosuchuser');
    expect(result).toBeNull();
  });

  it('returns null when BGG responds with 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      }),
    );
    const result = await validateBggUser('nosuchuser');
    expect(result).toBeNull();
  });

  it('gives up and throws after repeated 503s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
      }),
    );
    const promise = validateBggUser('anyone');
    const expectation = expect(promise).rejects.toThrow('503');
    await vi.runAllTimersAsync();
    await expectation;
    vi.useRealTimers();
  });

  it('retries a transient 503 and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('') })
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(VALID_USER_XML) });
    vi.stubGlobal('fetch', fetchMock);

    const promise = validateBggUser('boardgamefan');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result?.username).toBe('boardgamefan');
    vi.useRealTimers();
  });
});

// ── getBggUserProfile ─────────────────────────────────────────────────────────

describe('getBggUserProfile', () => {
  const USER_WITH_TOP_XML = `<?xml version="1.0" encoding="utf-8"?>
<user id="12345" name="boardgamefan" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <yearregistered value="2015" />
  <top domain="boardgame">
    <item rank="1" type="thing" id="174430" name="Gloomhaven" />
    <item rank="2" type="thing" id="224517" name="Brass: Birmingham" />
    <item rank="3" type="thing" id="342942" name="Ark Nova" />
  </top>
</user>`;

  const COLLECTION_XML = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="47" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse" pubdate="Fri, 27 Jun 2025 00:00:00 +0000">
</items>`;

  it('returns member since, base game count, expansion count, and top games', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(USER_WITH_TOP_XML),
      }) // user+top
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(COLLECTION_XML) }) // base games
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<items totalitems="12"></items>'),
      }); // expansions
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getBggUserProfile('boardgamefan');
    expect(profile).not.toBeNull();
    expect(profile?.memberSince).toBe('2015');
    expect(profile?.baseGames).toBe(47);
    expect(profile?.expansions).toBe(12);
    expect(profile?.topGames).toHaveLength(3);
    expect(profile?.topGames[0]).toEqual({ rank: 1, name: 'Gloomhaven' });
  });

  it('returns null counts when BGG responds 202 twice for both collection calls', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(USER_WITH_TOP_XML),
      })
      .mockResolvedValue({ ok: false, status: 202, text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', fetchMock);

    const profilePromise = getBggUserProfile('boardgamefan');
    await vi.runAllTimersAsync();
    const profile = await profilePromise;
    expect(profile?.baseGames).toBeNull();
    expect(profile?.expansions).toBeNull();
    vi.useRealTimers();
  });

  it('returns null when the user is not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') }),
    );
    const profile = await getBggUserProfile('nosuchuser');
    expect(profile).toBeNull();
  });

  it('returns empty top games when user has none set', async () => {
    const NO_TOP_XML = `<?xml version="1.0" encoding="utf-8"?>
<user id="12345" name="boardgamefan" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <yearregistered value="2020" />
</user>`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(NO_TOP_XML) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(COLLECTION_XML) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<items totalitems="0"></items>'),
      });
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getBggUserProfile('boardgamefan');
    expect(profile?.topGames).toHaveLength(0);
  });
});

// ── fetchBggOwnedCollection ───────────────────────────────────────────────────

describe('fetchBggOwnedCollection', () => {
  const COLLECTION_XML = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="2" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item objecttype="thing" objectid="266192" subtype="boardgame" collid="111">
    <name sortindex="1">Wingspan</name>
    <yearpublished>2019</yearpublished>
    <thumbnail>//cf.geekdo-images.com/thumb.jpg</thumbnail>
    <stats minplayers="1" maxplayers="5" minplaytime="40" maxplaytime="70" playingtime="70" numowned="50000">
      <rating value="8">
        <average value="7.85"/>
        <ranks>
          <rank type="subtype" id="1" name="boardgame" friendlyname="Board Game Rank" value="12"/>
        </ranks>
      </rating>
    </stats>
    <status own="1" prevowned="0" fortrade="0" want="0" wanttoplay="1" wishlistitem="0" preordered="0" lastmodified="2023-01-01 00:00:00"/>
    <numplays>5</numplays>
  </item>
  <item objecttype="thing" objectid="174430" subtype="boardgame" collid="222">
    <name sortindex="1">Gloomhaven</name>
    <yearpublished>2017</yearpublished>
    <thumbnail>//cf.geekdo-images.com/thumb2.jpg</thumbnail>
    <stats minplayers="1" maxplayers="4" minplaytime="60" maxplaytime="120" playingtime="120" numowned="80000">
      <rating value="N/A">
        <average value="8.50"/>
        <ranks>
          <rank type="subtype" id="1" name="boardgame" friendlyname="Board Game Rank" value="1"/>
        </ranks>
      </rating>
    </stats>
    <status own="1" prevowned="0" fortrade="1" want="0" wanttoplay="0" wishlistitem="0" preordered="0" lastmodified="2023-06-01 00:00:00"/>
    <numplays>12</numplays>
  </item>
</items>`;

  it('parses game names, IDs, players, and playtime', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(COLLECTION_XML) }),
    );
    const games = await fetchBggOwnedCollection('boardgamefan');
    expect(games).toHaveLength(2);
    expect(games![0].gameName).toBe('Wingspan');
    expect(games![0].bggGameId).toBe('266192');
    expect(games![0].minPlayers).toBe(1);
    expect(games![0].maxPlayers).toBe(5);
    expect(games![0].playingTime).toBe(70);
  });

  it('decodes HTML entities in game names', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="1">
  <item objecttype="thing" objectid="123" subtype="boardgame" collid="1">
    <name sortindex="1">EXIT: The Pharaoh&#039;s Tomb &amp; More</name>
    <stats minplayers="1" maxplayers="4" minplaytime="45" maxplaytime="45" playingtime="45" numowned="1000">
      <rating value="N/A"><average value="7.0"/><ranks/></rating>
    </stats>
    <status own="1" fortrade="0" wanttoplay="0" wishlistitem="0"/>
    <numplays>0</numplays>
  </item>
</items>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(xml) }),
    );
    const games = await fetchBggOwnedCollection('boardgamefan');
    expect(games![0].gameName).toBe("EXIT: The Pharaoh's Tomb & More");
  });

  it('returns both base games and expansions with correct isExpansion flag', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="2">
  <item objecttype="thing" objectid="1" subtype="boardgame" collid="1">
    <name sortindex="1">Base Game</name>
    <stats minplayers="1" maxplayers="4" minplaytime="30" maxplaytime="60" playingtime="60" numowned="1000">
      <rating value="N/A"><average value="7.0"/><ranks/></rating>
    </stats>
    <status own="1" fortrade="0" wanttoplay="0" wishlistitem="0"/>
    <numplays>0</numplays>
  </item>
  <item objecttype="thing" objectid="2" subtype="boardgameexpansion" collid="2">
    <name sortindex="1">Expansion Pack</name>
    <stats minplayers="1" maxplayers="4" minplaytime="30" maxplaytime="60" playingtime="60" numowned="500">
      <rating value="N/A"><average value="7.5"/><ranks/></rating>
    </stats>
    <status own="1" fortrade="0" wanttoplay="0" wishlistitem="0"/>
    <numplays>0</numplays>
  </item>
</items>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(xml) }),
    );
    const games = await fetchBggOwnedCollection('boardgamefan');
    expect(games).toHaveLength(2);
    expect(games![0].gameName).toBe('Base Game');
    expect(games![0].isExpansion).toBe(false);
    expect(games![1].gameName).toBe('Expansion Pack');
    expect(games![1].isExpansion).toBe(true);
  });

  it('parses status flags correctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(COLLECTION_XML) }),
    );
    const games = await fetchBggOwnedCollection('boardgamefan');
    expect(games![0].own).toBe(true);
    expect(games![0].forTrade).toBe(false);
    expect(games![0].wantToPlay).toBe(true);
    expect(games![1].forTrade).toBe(true);
  });

  it('parses user rating and num plays', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(COLLECTION_XML) }),
    );
    const games = await fetchBggOwnedCollection('boardgamefan');
    expect(games![0].userRating).toBe(8);
    expect(games![0].numPlays).toBe(5);
    expect(games![1].userRating).toBeNull(); // "N/A" rating
    expect(games![1].numPlays).toBe(12);
  });

  it('prepends https: to thumbnail URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(COLLECTION_XML) }),
    );
    const games = await fetchBggOwnedCollection('boardgamefan');
    expect(games![0].thumbnail).toBe('https://cf.geekdo-images.com/thumb.jpg');
  });

  it('returns null when BGG responds 202 twice', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 202, text: () => Promise.resolve('') }),
    );
    const promise = fetchBggOwnedCollection('boardgamefan');
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
    vi.useRealTimers();
  });

  it('gives up and returns null after repeated 503s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('') }),
    );
    const promise = fetchBggOwnedCollection('boardgamefan');
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
    vi.useRealTimers();
  });

  it('retries a transient 403 and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, text: () => Promise.resolve('') })
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(COLLECTION_XML) });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchBggOwnedCollection('boardgamefan');
    await vi.runAllTimersAsync();
    const games = await promise;
    expect(games).toHaveLength(2);
    vi.useRealTimers();
  });
});
