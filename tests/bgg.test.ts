import { describe, it, expect, vi, afterEach } from 'vitest';
import { BGG_TO_TAG, searchBGG, getBGGGame } from '../src/utils/bgg';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(xml: string, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(xml),
  }));
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
  it('returns parsed results from the BGG search API', async () => {
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
    expect(results[0]).toEqual({ id: '167791', name: 'Terraforming Mars', yearPublished: 2016 });
    expect(results[1]).toEqual({ id: '99999', name: 'Another Game', yearPublished: 2020 });
  });

  it('returns at most 5 results', async () => {
    const items = Array.from({ length: 8 }, (_, i) => `
  <item type="boardgame" id="${i}">
    <name type="primary" value="Game ${i}"/>
  </item>`).join('');
    mockFetch(`<items total="8">${items}</items>`);

    const results = await searchBGG('game');
    expect(results).toHaveLength(5);
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

  it('throws when the API returns a non-OK status', async () => {
    mockFetch('', 429);
    await expect(searchBGG('test')).rejects.toThrow('429');
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

  it('throws when the API returns a non-OK status', async () => {
    mockFetch('', 404);
    await expect(getBGGGame('0')).rejects.toThrow('404');
  });
});
