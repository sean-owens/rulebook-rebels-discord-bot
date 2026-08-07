import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  ForumChannel,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel,
  AutocompleteInteraction,
  ChannelFlags,
} from 'discord.js';
import {
  MarketplaceListing,
  Bid,
  Condition,
  CONDITION_LABELS,
  getActiveListingsForGuild,
  getListingsForGuild,
  getListing,
  findListingById,
  getUserListings,
  createListing,
  updateListing,
  addBid,
  updateBid,
  addCounter,
  acceptBid,
  buyNow,
  denyBid,
  closeListing,
  reopenListing,
  purgeListings,
  getOpenBid,
} from '../utils/marketplaceStorage';
import { appendMarketplaceLog } from '../utils/marketplaceLog';
import { pinWithRetry } from '../utils/discordPin';
import { getGuildConfig, updateGuildConfig } from '../utils/config';
import { removeGame, getGamesByUser } from '../utils/libraryStorage';
import { searchCatalog, searchCatalogWithFallback, getCatalogEntryById, BGGCatalogEntry } from '../utils/bggCatalog';
import { fetchBGGMarketplacePrices, getBGGGame } from '../utils/bgg';
import {
  SellDraft,
  saveDraft as persistDraft,
  deleteDraft as persistDeleteDraft,
  loadUnexpiredDrafts,
} from '../utils/marketplaceDraftStorage';

// ── Sell draft store (in-memory, expires after 15 min) ──────────────────────
//
// Reads (`sellDrafts.get`) go straight to the in-memory cache for speed, since
// they happen on every button/select interaction in the flow. Writes go
// through storeDraft/updateDraft/takeDraft below, which mirror the change to
// persistent storage (see src/utils/marketplaceDraftStorage.ts) best-effort —
// so a redeploy between two steps of a long sell flow doesn't strand the user
// with dead buttons pointing at a draft that no longer exists anywhere.

const sellDrafts = new Map<string, SellDraft>();

// Called once on bot startup to recover drafts that were in-progress when the
// process last stopped.
export async function hydrateSellDrafts(): Promise<void> {
  const stored = await loadUnexpiredDrafts();
  for (const [id, draft] of Object.entries(stored)) {
    sellDrafts.set(id, draft);
  }
}

function storeDraft(draft: Omit<SellDraft, 'expiresAt'>): string {
  const { randomUUID } = require('crypto') as typeof import('crypto');
  const id = randomUUID();
  const full: SellDraft = { ...draft, expiresAt: Date.now() + 15 * 60 * 1000 };
  sellDrafts.set(id, full);
  void persistDraft(id, full).catch((err) => console.warn(`Could not persist sell draft ${id}:`, err));
  // prune expired drafts opportunistically
  for (const [k, v] of sellDrafts) {
    if (v.expiresAt < Date.now()) {
      sellDrafts.delete(k);
      void persistDeleteDraft(k).catch(() => {});
    }
  }
  return id;
}

function updateDraft(draftId: string, patch: Partial<SellDraft>): SellDraft | undefined {
  const draft = sellDrafts.get(draftId);
  if (!draft) return undefined;
  const updated = { ...draft, ...patch };
  sellDrafts.set(draftId, updated);
  void persistDraft(draftId, updated).catch((err) =>
    console.warn(`Could not persist sell draft ${draftId}:`, err),
  );
  return updated;
}

// In-memory only (unlike sellDrafts, this only tracks the first couple of
// wizard steps — item name + listing type — before a real, persisted draft
// exists), keyed by userId, mirroring pendingLibrarySuggest/pendingBrings-style
// maps elsewhere in this codebase. Lost on a redeploy mid-wizard; the user just
// restarts from the hub button, same as those other short-lived flows.
interface PendingHubListing {
  listingType: 'sell' | 'trade';
  itemName: string;
  condition?: Condition;
}
const pendingHubListings = new Map<string, PendingHubListing>();


function formatPrice(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildPriceHistogram(prices: number[], bucketCount = 5): string {
  if (prices.length === 0) return '';
  const sorted = [...prices].sort((a, b) => a - b);

  // Trim extreme outliers: use P10–P90 to set bucket boundaries
  const p10idx = Math.floor((10 / 100) * (sorted.length - 1));
  const p90idx = Math.ceil((90 / 100) * (sorted.length - 1));
  const lo = sorted[p10idx];
  const hi = sorted[p90idx];
  const range = hi - lo;

  if (range <= 0) {
    return `All ${prices.length} listing${prices.length > 1 ? 's' : ''} near ${formatPrice(lo)}`;
  }

  const width = range / bucketCount;
  const counts = Array<number>(bucketCount).fill(0);
  for (const v of prices) {
    let b = Math.floor((v - lo) / width);
    b = Math.max(0, Math.min(bucketCount - 1, b));
    counts[b]++;
  }

  const maxCount = Math.max(...counts);
  const BAR_MAX = 10;
  return counts
    .map((count, i) => {
      const bucketLo = lo + i * width;
      const bucketHi = bucketLo + width;
      const barLen = maxCount > 0 ? Math.round((count / maxCount) * BAR_MAX) : 0;
      const bar = barLen > 0 ? '█'.repeat(barLen) : '▏';
      return `\`$${bucketLo.toFixed(0).padStart(3)}–$${bucketHi.toFixed(0).padEnd(3)}\` ${bar} ${count}`;
    })
    .join('\n');
}

function takeDraft(draftId: string): SellDraft | undefined {
  const draft = sellDrafts.get(draftId);
  if (!draft) return undefined;
  sellDrafts.delete(draftId);
  void persistDeleteDraft(draftId).catch((err) =>
    console.warn(`Could not delete persisted sell draft ${draftId}:`, err),
  );
  if (draft.expiresAt < Date.now()) return undefined;
  return draft;
}

// ── Command definition ──────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName('marketplace')
  .setDescription('Buy, sell, and trade items with other members')
  // ── post group ──────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('post')
      .setDescription('Post a new listing')
      .addSubcommand((sub) =>
        sub
          .setName('sell')
          .setDescription('List an item for sale')
          .addStringOption((opt) =>
            opt
              .setName('item')
              .setDescription('Item name (searches BoardGameGeek, or choose "not on BGG" for custom items)')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('offers_allowed')
              .setDescription('Allow buyers to submit offers below your asking price?')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('condition')
              .setDescription('Condition of the item')
              .setRequired(true)
              .addChoices(
                { name: 'New', value: 'new' },
                { name: 'Like New', value: 'like_new' },
                { name: 'Very Good', value: 'very_good' },
                { name: 'Good', value: 'good' },
                { name: 'Acceptable', value: 'acceptable' },
              ),
          )
          .addStringOption((opt) =>
            opt.setName('notes').setDescription('Additional details').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('trade')
          .setDescription('List an item you want to trade away')
          .addStringOption((opt) =>
            opt
              .setName('item')
              .setDescription('Item name (searches BoardGameGeek, or choose "not on BGG" for custom items)')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('condition')
              .setDescription('Condition of the item')
              .setRequired(true)
              .addChoices(
                { name: 'New', value: 'new' },
                { name: 'Like New', value: 'like_new' },
                { name: 'Very Good', value: 'very_good' },
                { name: 'Good', value: 'good' },
                { name: 'Acceptable', value: 'acceptable' },
              ),
          )
          .addStringOption((opt) =>
            opt
              .setName('looking_for')
              .setDescription('What you want in return (e.g. "Wingspan or Ark Nova")')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('notes').setDescription('Additional details').setRequired(false),
          ),
      ),
  )
  // ── top-level subcommands ───────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub
      .setName('browse')
      .setDescription('Browse active marketplace listings')
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Filter by listing type')
          .setRequired(false)
          .addChoices(
            { name: 'For Sale', value: 'sell' },
            { name: 'For Trade', value: 'trade' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('my').setDescription('View and manage your own listings'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close one of your active listings')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Your active listing to close').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reopen')
      .setDescription('Reopen a sold or closed listing')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Your closed/sold listing to reopen').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('price')
      .setDescription('Look up current BoardGameGeek marketplace prices for a game without creating a listing')
      .addStringOption((opt) =>
        opt.setName('item').setDescription('Game name').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('conditions').setDescription('Show the condition grading scale used for marketplace listings'),
  );

// ── Autocomplete ────────────────────────────────────────────────────────────

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  const focusedOption = interaction.options.getFocused(true);

  if ((sub === 'close' || sub === 'reopen') && focusedOption.name === 'id') {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const query = focusedOption.value.toLowerCase();

    const listings = (await getUserListings(guildId, userId)).filter((l) =>
      sub === 'close'
        ? l.status === 'active' || l.status === 'pending'
        : l.status === 'sold' || l.status === 'closed',
    );

    const typeLabel = (l: MarketplaceListing) => (l.type === 'sell' ? 'Sell' : 'Trade');
    const statusLabel: Record<string, string> = { active: 'Active', pending: 'Pending', sold: 'Sold', closed: 'Closed' };

    const choices = listings
      .filter((l) => !query || l.itemName.toLowerCase().includes(query))
      .slice(0, 25)
      .map((l) => ({
        name: `${l.itemName} (${typeLabel(l)} · ${statusLabel[l.status]})`.slice(0, 100),
        value: l.id,
      }));

    await interaction.respond(choices);
    return;
  }

  // Default: item name search for post sell/trade
  const focused = focusedOption.value;
  if (!focused) {
    await interaction.respond([{ name: 'Start typing an item name…', value: '__placeholder__' }]);
    return;
  }
  const results = searchCatalog(focused).slice(0, 24);
  const choices = results.map((r) => ({
    name: `${r.isExpansion ? '[Expansion] ' : ''}${r.name} (${r.year ?? '?'})`.slice(0, 100),
    // Encodes the BGG id rather than the name so resolveMarketplaceItem can
    // tell an explicit pick apart from free-typed text that happens to match
    // some other entry's name exactly (see resolveMarketplaceItem's __bgg__
    // branch) — the root cause of a game like "Gloom" silently winning over
    // "Gloomhaven" when a user types "gloom" and submits before finishing.
    value: `__bgg__:${r.id}`,
  }));
  // Prefix with __custom__: so the handler knows to skip the BGG catalog lookup
  choices.push({ name: `📝 "${focused.slice(0, 75)}" — not on BGG / custom item`, value: `__custom__:${focused}`.slice(0, 100) });
  await interaction.respond(choices);
}

// ── Embed builders ──────────────────────────────────────────────────────────

function bundleDisplayTitle(itemName: string, expansionCount: number, includesBase: boolean): string {
  if (includesBase && expansionCount > 0) {
    return `${itemName} + Base Game + ${expansionCount} expansion${expansionCount > 1 ? 's' : ''}`;
  } else if (includesBase) {
    return `${itemName} + Base Game`;
  } else if (expansionCount > 0) {
    return `${itemName} + ${expansionCount} expansion${expansionCount > 1 ? 's' : ''}`;
  }
  return itemName;
}

function listingEmbed(listing: MarketplaceListing): EmbedBuilder {
  const expCount = listing.expansions?.length ?? 0;
  const includesBase = !!(listing.includesBaseGame && listing.parentItem);
  const displayTitle = bundleDisplayTitle(listing.itemName, expCount, includesBase);
  const type = listing.type === 'sell' ? '🏷️ For Sale' : '🔄 For Trade';
  const statusEmoji: Record<string, string> = {
    active: '🟢',
    pending: '🟡',
    sold: '🔴',
    closed: '⚫',
  };

  const openOffers = listing.bids.filter((b) => b.status === 'open').length;

  const embed = new EmbedBuilder()
    .setColor(listing.type === 'sell' ? 0x57f287 : 0xfee75c)
    .setTitle(`${type} — ${displayTitle}`)
    .setFooter({ text: `Listing ID: ${listing.id} • Listed by ${listing.username}` })
    .setTimestamp(new Date(listing.createdAt));

  const descLines: string[] = [];
  if (listing.bggId) {
    descLines.push(`[View on BoardGameGeek](https://boardgamegeek.com/boardgame/${listing.bggId})`);
  }
  if (listing.parentItem) {
    const parentUrl = `https://boardgamegeek.com/boardgame/${listing.parentItem.bggId}`;
    descLines.push(includesBase
      ? `[Base game on BGG](${parentUrl})`
      : `[Base game on BGG](${parentUrl}) (not included)`);
  }
  if (listing.referenceLink) {
    descLines.push(`[Reference link](${listing.referenceLink})`);
  }
  if (descLines.length > 0) embed.setDescription(descLines.join('  ·  '));
  if (listing.thumbnail) embed.setThumbnail(listing.thumbnail);

  const fields: { name: string; value: string; inline?: boolean }[] = [];

  if (listing.type === 'sell') {
    const priceDisplay = listing.askingPrice != null
      ? formatPrice(listing.askingPrice)
      : 'Open to offers';
    fields.push({ name: 'Price', value: priceDisplay, inline: true });
    fields.push({
      name: 'Negotiable?',
      value: listing.bidsAllowed ? '💬 Open to Offers' : '🔒 Firm Price',
      inline: true,
    });
  } else {
    fields.push({
      name: 'Offering',
      value: displayTitle,
      inline: true,
    });
    fields.push({
      name: 'Looking For',
      value: listing.lookingFor || 'Open to offers',
      inline: true,
    });
  }

  if (listing.condition) {
    fields.push({ name: 'Condition', value: CONDITION_LABELS[listing.condition], inline: true });
  }

  fields.push({
    name: 'Status',
    value: `${statusEmoji[listing.status]} ${listing.status.charAt(0).toUpperCase() + listing.status.slice(1)}${openOffers > 0 ? ` (${openOffers} open offer${openOffers > 1 ? 's' : ''})` : ''}`,
    inline: true,
  });

  if (listing.expansions && listing.expansions.length > 0) {
    fields.push({
      name: `Includes ${listing.expansions.length} Expansion${listing.expansions.length > 1 ? 's' : ''}`,
      value: listing.expansions.map((e) => `• ${e.name}`).join('\n').slice(0, 1024),
    });
  }

  if (includesBase) {
    fields.push({ name: 'Includes Base Game', value: `• ${listing.parentItem!.name}` });
  }

  if (listing.notes) fields.push({ name: 'Notes', value: listing.notes });

  embed.addFields(fields);
  return embed;
}

// Firm-price listings get a "Buy It Now" button alongside "I'm Interested" —
// there's no price to negotiate, so a buyer who's already decided doesn't need
// to wait on the seller reviewing an offer. Negotiable sells and trades only
// ever show "I'm Interested" since there's no fixed price to instantly claim.
function interestButton(
  listing: Pick<MarketplaceListing, 'id' | 'type' | 'bidsAllowed'>,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = [];
  if (isFirmListing(listing)) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`mp_buynow_${listing.id}`)
        .setLabel('Buy It Now')
        .setStyle(ButtonStyle.Success)
        .setEmoji('⚡')
        .setDisabled(disabled),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`mp_interest_${listing.id}`)
      .setLabel("I'm Interested")
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🤝')
      .setDisabled(disabled),
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

// A firm-price sell listing has no price to negotiate, so the seller only gets
// Accept/Deny — the Counter button only makes sense when there's room to move
// on price (negotiable sells) or on what's being exchanged (trades).
function isFirmListing(listing: Pick<MarketplaceListing, 'type' | 'bidsAllowed'>): boolean {
  return listing.type === 'sell' && !listing.bidsAllowed;
}

function bidActionRow(listingId: string, bidId: string, allowCounter = true): ActionRowBuilder<ButtonBuilder> {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`mp_accept_${listingId}_${bidId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mp_deny_${listingId}_${bidId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  ];
  if (allowCounter) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`mp_counter_${listingId}_${bidId}`)
        .setLabel('Counter')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

function buyerResponseRow(listingId: string, bidId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mp_buyer_accept_${listingId}_${bidId}`)
      .setLabel('Accept Counter')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mp_buyer_deny_${listingId}_${bidId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`mp_counter_${listingId}_${bidId}`)
      .setLabel('Counter Again')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Forum tag helpers ───────────────────────────────────────────────────────

const MARKETPLACE_TAG_KEYS = ['sell', 'trade', 'active', 'pending', 'sold', 'closed'] as const;
type MarketplaceTagKey = (typeof MARKETPLACE_TAG_KEYS)[number];

const TAG_NAMES: Record<MarketplaceTagKey, string> = {
  sell: 'For Sale',
  trade: 'For Trade',
  active: 'Active',
  pending: 'Pending',
  sold: 'Sold',
  closed: 'Closed',
};

async function ensureMarketplaceTags(
  forumChannel: ForumChannel,
  guildId: string,
): Promise<Record<string, string>> {
  const config = await getGuildConfig(guildId);
  const tagIds: Record<string, string> = { ...config.marketplaceTagIds };
  const existingByName = new Map(forumChannel.availableTags.map((t) => [t.name, t.id]));

  const missing = MARKETPLACE_TAG_KEYS.filter((key) => {
    if (tagIds[key]) return false;
    const existingId = existingByName.get(TAG_NAMES[key]);
    if (existingId) { tagIds[key] = existingId; return false; }
    return true;
  });

  if (missing.length > 0) {
    const merged = [
      ...forumChannel.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated })),
      ...missing.map((key) => ({ name: TAG_NAMES[key], moderated: false })),
    ];
    const updated = await forumChannel.setAvailableTags(merged);
    for (const key of missing) {
      const found = updated.availableTags.find((t) => t.name === TAG_NAMES[key]);
      if (found) tagIds[key] = found.id;
    }
  }

  await updateGuildConfig(guildId, { marketplaceTagIds: tagIds });
  return tagIds;
}

function resolvedTags(tagIds: Record<string, string>, type: 'sell' | 'trade', status: string): string[] {
  const finalised = status === 'sold' || status === 'closed';
  const typeTag = finalised ? undefined : tagIds[type === 'sell' ? 'sell' : 'trade'];
  return [typeTag, tagIds[status]].filter(Boolean) as string[];
}

// ── Forum post helpers ──────────────────────────────────────────────────────

const CONDITION_LABEL: Record<string, string> = {
  new: 'New',
  like_new: 'Like New',
  very_good: 'Very Good',
  good: 'Good',
  acceptable: 'Acceptable',
};

function buildThreadTitle(listing: MarketplaceListing): string {
  const prefix = listing.type === 'sell' ? '[SELL]' : '[TRADE]';
  const expCount = listing.expansions?.length ?? 0;
  const includesBase = !!(listing.includesBaseGame && listing.parentItem);
  const itemLabel = bundleDisplayTitle(listing.itemName, expCount, includesBase);
  const meta: string[] = [];
  if (listing.askingPrice != null) meta.push(formatPrice(listing.askingPrice));
  if (listing.condition) meta.push(CONDITION_LABEL[listing.condition] ?? listing.condition);
  const title = meta.length > 0 ? `${prefix} ${itemLabel} · ${meta.join(' · ')}` : `${prefix} ${itemLabel}`;
  return title.length <= 100 ? title : title.slice(0, 97) + '…';
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function postListingToForum(
  listing: MarketplaceListing,
  forumChannel: ForumChannel,
  guildId: string,
): Promise<string | undefined> {
  try {
    const tagIds = await ensureMarketplaceTags(forumChannel, guildId);
    const appliedTags = resolvedTags(tagIds, listing.type, listing.status);

    const bggAttachment = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');
    const embed = listingEmbed(listing);
    embed.setImage('attachment://powered_by_BGG_01_SM.png');

    const thumbBuffer = listing.thumbnail ? await fetchImageBuffer(listing.thumbnail) : null;

    let thread;
    if (thumbBuffer) {
      // Starter message: just the thumbnail image — Discord uses this for the forum card preview
      thread = await forumChannel.threads.create({
        name: buildThreadTitle(listing),
        appliedTags,
        message: {
          files: [new AttachmentBuilder(thumbBuffer, { name: 'thumbnail.jpg' })],
        },
      });
      // Second message: the actual listing embed + BGG logo + button
      await thread.send({
        embeds: [embed],
        files: [bggAttachment],
        components: [interestButton(listing)],
      });
    } else {
      // No thumbnail — single message with embed + BGG logo
      thread = await forumChannel.threads.create({
        name: buildThreadTitle(listing),
        appliedTags,
        message: {
          embeds: [embed],
          files: [bggAttachment],
          components: [interestButton(listing)],
        },
      });
    }

    return thread.id;
  } catch (err) {
    console.error('[marketplace] forum post failed:', err);
    return undefined;
  }
}

// Text-channel equivalent of postListingToForum — unlike forum mode, no
// Discord thread is created. The listing is a single plain message (the
// thumbnail, if any, is already embedded via listingEmbed's setThumbnail —
// the forum version's separate thumbnail-only starter message exists purely
// to feed Discord's forum card preview, which has no text-channel
// equivalent). Follow-up activity is posted as a reply to this message
// instead of into a thread — see postListingFollowup.
async function postListingToTextChannel(
  listing: MarketplaceListing,
  textChannel: TextChannel,
  guildId: string,
): Promise<string | undefined> {
  try {
    const bggAttachment = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');
    const embed = listingEmbed(listing);
    embed.setImage('attachment://powered_by_BGG_01_SM.png');

    const message = await textChannel.send({
      embeds: [embed],
      files: [bggAttachment],
      components: [interestButton(listing)],
    });

    await updateMarketplaceListingIndex(textChannel.client, guildId);

    return message.id;
  } catch (err) {
    console.error('[marketplace] text channel post failed:', err);
    return undefined;
  }
}

type ListingPostRef = Partial<Pick<MarketplaceListing, 'forumThreadId' | 'listingMessageId' | 'listingChannelId'>>;

// Shared by finalizeSellListing and its trade equivalent — resolves the
// configured marketplace channel and dispatches to the Forum or Text poster
// based on its live type, so a listing can be created regardless of which
// mode a guild has configured. Returns the mode-appropriate id(s) to persist
// on the listing (see updateListing's patch type).
async function postListingToChannel(
  listing: MarketplaceListing,
  guildId: string,
  client: Client,
): Promise<ListingPostRef | undefined> {
  const config = await getGuildConfig(guildId);
  if (!config.marketplaceChannelId) return undefined;
  try {
    const channel = await client.channels.fetch(config.marketplaceChannelId);
    if (channel?.type === ChannelType.GuildForum) {
      const threadId = await postListingToForum(listing, channel as ForumChannel, guildId);
      return threadId ? { forumThreadId: threadId } : undefined;
    }
    if (channel?.type === ChannelType.GuildText) {
      const messageId = await postListingToTextChannel(listing, channel as TextChannel, guildId);
      return messageId ? { listingMessageId: messageId, listingChannelId: channel.id } : undefined;
    }
    return undefined;
  } catch (err) {
    console.error('[marketplace] marketplace channel fetch failed:', err);
    return undefined;
  }
}

// Builds the "View listing" URL for either mode, or undefined if the listing
// was never posted (e.g. no marketplace channel configured at creation time).
function listingLink(ref: ListingPostRef, guildId: string): string | undefined {
  if (ref.forumThreadId) {
    return `https://discord.com/channels/${guildId}/${ref.forumThreadId}`;
  }
  if (ref.listingMessageId && ref.listingChannelId) {
    return `https://discord.com/channels/${guildId}/${ref.listingChannelId}/${ref.listingMessageId}`;
  }
  return undefined;
}

/** Strip buttons from a bid's outstanding DM/thread-fallback prompt and append a closing note. */
async function lockBidDm(client: Client, bid: Bid, note: string): Promise<void> {
  if (!bid.dmChannelId || !bid.dmMessageId) return;
  try {
    const channel = await client.channels.fetch(bid.dmChannelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(bid.dmMessageId);
    await message.edit({ content: `${message.content}\n\n${note}`, components: [] });
  } catch { /* message may be gone or inaccessible */ }
}

// Posts a follow-up visible to everyone watching the listing — a new-offer
// notification, a DM-disabled fallback with response buttons, or a sold/
// closed announcement. Forum mode posts into the listing's thread; Text mode
// has no thread, so it replies to the listing message instead (same visual
// grouping via Discord's reply UI, no thread channel created). Returns the
// sent message's channel+id so callers can persist it as a bid's DM-fallback
// location via updateBid, or null if there's nowhere to post (no marketplace
// channel configured, or the listing/thread/message is gone).
async function postListingFollowup(
  listing: MarketplaceListing,
  client: Client,
  payload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] },
): Promise<{ channelId: string; id: string } | null> {
  try {
    if (listing.forumThreadId) {
      const thread = await client.channels.fetch(listing.forumThreadId) as ThreadChannel;
      if (!thread) return null;
      const sent = await thread.send(payload);
      return { channelId: sent.channelId, id: sent.id };
    }
    if (listing.listingMessageId && listing.listingChannelId) {
      const channel = await client.channels.fetch(listing.listingChannelId);
      if (!channel || !channel.isTextBased()) return null;
      const message = await channel.messages.fetch(listing.listingMessageId).catch(() => null);
      if (!message) return null;
      const sent = await message.reply(payload);
      return { channelId: sent.channelId, id: sent.id };
    }
  } catch (err) {
    console.error('[marketplace] listing followup post failed:', err);
  }
  return null;
}

// Channel-agnostic: works whether listing.forumThreadId is a forum post's own
// thread or a thread started off a message in a Text channel (see
// postListingToChannel). Forum-only steps (tag updates) are skipped when the
// thread's parent isn't a forum channel; Text-only steps (the listing index
// pin) are refreshed when it is a text channel.
// Dispatches to the Forum-thread or Text-message updater based on which id(s)
// are populated on the listing — set once at creation time by
// postListingToChannel and never mixed on a single listing.
async function updateListingPost(
  listing: MarketplaceListing,
  client: Client,
  guildId: string,
): Promise<void> {
  if (listing.forumThreadId) {
    await updateForumThreadPost(listing, client, guildId);
  } else if (listing.listingMessageId && listing.listingChannelId) {
    await updateTextChannelListingMessage(listing, client, guildId);
  }
}

async function updateForumThreadPost(
  listing: MarketplaceListing,
  client: Client,
  guildId: string,
): Promise<void> {
  if (!listing.forumThreadId) return;
  try {
    const thread = await client.channels.fetch(listing.forumThreadId) as ThreadChannel;
    if (!thread) return;

    // Update applied tags to reflect current status
    const config = await getGuildConfig(guildId);
    const tags = resolvedTags(config.marketplaceTagIds, listing.type, listing.status);
    if (tags.length > 0) {
      await (thread as any).setAppliedTags(tags);
    }

    // When a thumbnail is present, the starter message is just the image and the
    // listing embed lives in the second message. Try the second message first;
    // fall back to the starter for listings with no thumbnail.
    let embedMsg = null;
    const afterMsgs = await thread.messages.fetch({ limit: 1, after: thread.id }).catch(() => null);
    const secondMsg = afterMsgs?.first?.();
    if (secondMsg && secondMsg.author.id === client.user!.id && secondMsg.embeds.length > 0) {
      embedMsg = secondMsg;
    } else {
      embedMsg = await thread.messages.fetch(thread.id).catch(() => null);
    }
    if (!embedMsg || embedMsg.author.id !== client.user!.id) return;

    const bggAttachment = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');
    const embed = listingEmbed(listing);
    embed.setImage('attachment://powered_by_BGG_01_SM.png');

    const isFinalised = listing.status === 'sold' || listing.status === 'closed';
    await embedMsg.edit({
      embeds: [embed],
      files: [bggAttachment],
      components: isFinalised ? [] : [interestButton(listing)],
    });

    if (isFinalised) {
      const closingMessage = listing.status === 'sold'
        ? `🔴 **This listing has been sold.** Thank you for using the marketplace!`
        : `⚫ **This listing has been closed** and is no longer available.`;
      await thread.send(closingMessage);
      await thread.setLocked(true);
      await thread.setArchived(true);
    } else {
      // Reopened — unarchive and unlock so members can post again
      await thread.setArchived(false);
      await thread.setLocked(false);
    }
  } catch (err) {
    console.error('[marketplace] forum thread update failed:', err);
  }
}

// Text-mode equivalent — edits the single listing message in place; there's
// no thread to lock/archive, so "closed" is communicated by dropping the
// button and posting a reply, and "reopened" by the button simply coming
// back on the next edit.
async function updateTextChannelListingMessage(
  listing: MarketplaceListing,
  client: Client,
  guildId: string,
): Promise<void> {
  if (!listing.listingMessageId || !listing.listingChannelId) return;
  try {
    const channel = await client.channels.fetch(listing.listingChannelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(listing.listingMessageId).catch(() => null);
    if (!message || message.author.id !== client.user!.id) return;

    const bggAttachment = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');
    const embed = listingEmbed(listing);
    embed.setImage('attachment://powered_by_BGG_01_SM.png');

    const isFinalised = listing.status === 'sold' || listing.status === 'closed';
    await message.edit({
      embeds: [embed],
      files: [bggAttachment],
      components: isFinalised ? [] : [interestButton(listing)],
    });

    if (isFinalised) {
      const closingMessage = listing.status === 'sold'
        ? `🔴 **This listing has been sold.** Thank you for using the marketplace!`
        : `⚫ **This listing has been closed** and is no longer available.`;
      await message.reply(closingMessage);
    }
  } catch (err) {
    console.error('[marketplace] text channel listing update failed:', err);
  } finally {
    await updateMarketplaceListingIndex(client, guildId).catch(() => null);
  }
}

// ── Item resolution (search-match confirmation) ─────────────────────────────
// Shared by post sell/trade/price — resolving a raw "item" value (whether
// from a slash-command autocomplete field or the hub wizard's free-text
// modal) into BGG catalog data, one way, in one place.

async function resolveCatalogDetails(entry: BGGCatalogEntry): Promise<{
  bggId: string;
  thumbnail?: string;
  isExpansion: boolean;
  availableExpansions: { bggId: string; name: string }[];
  parentItem?: { bggId: string; name: string };
}> {
  const bggId = String(entry.id);
  const details = await getBGGGame(bggId).catch(() => null);
  return {
    bggId,
    thumbnail: details?.thumbnail ?? undefined,
    isExpansion: entry.isExpansion,
    availableExpansions:
      !entry.isExpansion && details?.expansions
        ? details.expansions.map((e) => ({ bggId: e.id, name: e.name }))
        : [],
    parentItem:
      entry.isExpansion && details?.parentGame
        ? { bggId: details.parentGame.id, name: details.parentGame.name }
        : undefined,
  };
}

interface ResolvedMarketplaceItem {
  itemName: string;
  bggId?: string;
  thumbnail?: string;
  isExpansion: boolean;
  availableExpansions: { bggId: string; name: string }[];
  parentItem?: { bggId: string; name: string };
  // False only when bggId came from a free-text guess (searchCatalog's top
  // result for unselected/typed text) rather than an explicit pick — the
  // only case where the match needs confirming before it's trusted. An
  // explicit __bgg__: pick or __custom__: choice is always confident, since
  // there's nothing ambiguous about either.
  confident: boolean;
  // The catalog entry's real name/year, present whenever bggId is set —
  // itemName intentionally stays the user's own raw text (unchanged from
  // before this fix) so listing titles still reflect what they typed;
  // matchedName/matchedYear are what actually get attached, used for the
  // confirmation prompt and the /marketplace price "best guess" note.
  matchedName?: string;
  matchedYear?: number | null;
}

async function resolveMarketplaceItem(rawItem: string): Promise<ResolvedMarketplaceItem> {
  if (rawItem.startsWith('__custom__:')) {
    return {
      itemName: rawItem.slice('__custom__:'.length),
      isExpansion: false,
      availableExpansions: [],
      confident: true,
    };
  }

  if (rawItem.startsWith('__bgg__:')) {
    const entry = getCatalogEntryById(rawItem.slice('__bgg__:'.length));
    if (entry) {
      try {
        const details = await resolveCatalogDetails(entry);
        return { itemName: entry.name, ...details, confident: true, matchedName: entry.name, matchedYear: entry.year };
      } catch {
        // BGG lookup is best-effort
      }
    }
    // Catalog entry vanished since the dropdown was shown — treat as unmatched.
    return { itemName: rawItem, isExpansion: false, availableExpansions: [], confident: true };
  }

  // Free-typed text — an unselected autocomplete suggestion, or the hub
  // wizard's modal, which has no autocomplete at all. A match here is only
  // ever a guess (see the "Gloom" vs "Gloomhaven" example above).
  try {
    const results = await searchCatalogWithFallback(rawItem);
    if (results.length > 0) {
      const entry = results[0];
      const details = await resolveCatalogDetails(entry);
      return { itemName: rawItem, ...details, confident: false, matchedName: entry.name, matchedYear: entry.year };
    }
  } catch {
    // BGG lookup is best-effort
  }
  return { itemName: rawItem, isExpansion: false, availableExpansions: [], confident: true };
}

// The shared "what's next" branch after an item has been resolved (and, if
// needed, confirmed) — used at initial draft creation and after every
// confirmation-prompt outcome. Identical for sell/trade except the final step.
async function continueAfterItemResolved(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  draft: SellDraft,
  draftId: string,
): Promise<void> {
  if (!draft.bggId) {
    await showNoBggPrompt(interaction, draft.itemName, draftId);
  } else if (!draft.isExpansion && (draft.availableExpansions?.length ?? 0) > 0) {
    await showExpansionSelect(interaction, draft, draftId);
  } else if (draft.isExpansion && draft.parentItem) {
    await showIncludeBaseGameSelect(interaction, draft, draftId);
  } else if (draft.listingType === 'sell') {
    await showPriceScreen(interaction, draft, draftId);
  } else {
    await createTradeListing(interaction, draft);
  }
}

async function showConfirmMatchPrompt(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  draft: SellDraft,
  draftId: string,
  matchedName: string,
  matchedYear: number | null | undefined,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Found a possible match')
    .setDescription(
      `You searched for **${draft.itemName}** — is this the game you meant?\n\n` +
      `${draft.isExpansion ? '🧩' : '🎲'} **${matchedName}**${matchedYear ? ` (${matchedYear})` : ''}`,
    );
  if (draft.thumbnail) embed.setThumbnail(draft.thumbnail);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mp_match_yes_${draftId}`).setLabel("Yes, that's it").setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`mp_match_search_${draftId}`).setLabel('Search again').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
    new ButtonBuilder().setCustomId(`mp_match_notbgg_${draftId}`).setLabel('Not on BGG').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function handleMatchConfirmYes(interaction: ButtonInteraction, draftId: string): Promise<void> {
  await interaction.deferUpdate();
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.', embeds: [], components: [] });
    return;
  }
  await continueAfterItemResolved(interaction, draft, draftId);
}

export async function handleMatchConfirmNotBgg(interaction: ButtonInteraction, draftId: string): Promise<void> {
  await interaction.deferUpdate();
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.', embeds: [], components: [] });
    return;
  }
  const updated = updateDraft(draftId, {
    bggId: undefined,
    thumbnail: undefined,
    isExpansion: false,
    availableExpansions: [],
    parentItem: undefined,
  })!;
  await showNoBggPrompt(interaction, updated.itemName, draftId);
}

export async function handleMatchConfirmSearchAgain(interaction: ButtonInteraction, draftId: string): Promise<void> {
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.reply({ content: 'This session has expired. Please run the command again.', flags: MessageFlags.Ephemeral });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`mp_match_research_modal_${draftId}`)
    .setTitle('Search Again')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('item')
          .setLabel('Item name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Gloomhaven')
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleMatchResearchModal(interaction: ModalSubmitInteraction, draftId: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.' });
    return;
  }

  const rawItem = interaction.fields.getTextInputValue('item').trim();
  const resolution = await resolveMarketplaceItem(rawItem);
  const updated = updateDraft(draftId, {
    itemName: resolution.itemName,
    bggId: resolution.bggId,
    thumbnail: resolution.thumbnail,
    isExpansion: resolution.isExpansion,
    availableExpansions: resolution.availableExpansions,
    parentItem: resolution.parentItem,
  })!;

  if (updated.bggId && !resolution.confident && resolution.matchedName) {
    await showConfirmMatchPrompt(interaction, updated, draftId, resolution.matchedName, resolution.matchedYear);
    return;
  }
  await continueAfterItemResolved(interaction, updated, draftId);
}

// ── /marketplace post sell ──────────────────────────────────────────────────

async function handlePostSell(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rawItem = interaction.options.getString('item', true);
  const bidsAllowed = interaction.options.getBoolean('offers_allowed', true);
  const condition = interaction.options.getString('condition', true) as Condition;
  const notes = interaction.options.getString('notes') ?? undefined;
  const guildId = interaction.guildId!;

  if (rawItem === '__placeholder__') {
    await interaction.editReply({ content: 'Please type an item name and select an option from the list.' });
    return;
  }

  const displayName = interaction.member
    ? (interaction.member as { displayName?: string }).displayName ?? interaction.user.username
    : interaction.user.username;

  await createSellDraftAndContinue(
    interaction,
    guildId,
    interaction.user.id,
    displayName,
    rawItem,
    condition,
    notes,
    bidsAllowed,
  );
}

// Shared by the slash command above, the marketplace hub's Sell wizard (see
// handleHubMarketplaceOffers below), and "search again" on the match-
// confirmation prompt — everything after the item name/condition/offers-
// allowed choice is resolved identically regardless of how those were
// collected. rawItem may carry a __custom__:/__bgg__: sentinel (slash-command
// autocomplete) or be plain free-typed text (hub wizard modal, or an
// unselected autocomplete suggestion) — resolveMarketplaceItem sorts that out.
async function createSellDraftAndContinue(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  guildId: string,
  userId: string,
  displayName: string,
  rawItem: string,
  condition: Condition,
  notes: string | undefined,
  bidsAllowed: boolean,
): Promise<void> {
  const resolution = await resolveMarketplaceItem(rawItem);

  const draft: Omit<SellDraft, 'expiresAt'> = {
    listingType: 'sell',
    guildId,
    userId,
    username: displayName,
    itemName: resolution.itemName,
    bggId: resolution.bggId,
    thumbnail: resolution.thumbnail,
    isExpansion: resolution.isExpansion,
    availableExpansions: resolution.availableExpansions,
    parentItem: resolution.parentItem,
    condition,
    notes,
    bidsAllowed,
  };

  const draftId = storeDraft(draft);
  const stored = sellDrafts.get(draftId)!;

  if (stored.bggId && !resolution.confident && resolution.matchedName) {
    await showConfirmMatchPrompt(interaction, stored, draftId, resolution.matchedName, resolution.matchedYear);
    return;
  }
  await continueAfterItemResolved(interaction, stored, draftId);
}

async function showExpansionSelect(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  draft: SellDraft,
  draftId: string,
): Promise<void> {
  const expansions = draft.availableExpansions ?? [];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`mp_exp_select_${draftId}`)
    .setPlaceholder('Select expansions you are including…')
    .setMinValues(1)
    .setMaxValues(expansions.length)
    .addOptions(expansions.map((exp) => ({ label: exp.name.slice(0, 100), value: exp.bggId })));

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const skipRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mp_exp_skip_${draftId}`)
      .setLabel('Skip — base item only')
      .setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Expansions for ${draft.itemName}`)
    .setDescription(
      `Found **${expansions.length}** expansion${expansions.length > 1 ? 's' : ''} on BGG. ` +
      `Select any you're including in this listing, then submit the menu — or skip to list the base item only.`,
    );
  if (draft.thumbnail) embed.setThumbnail(draft.thumbnail);

  await interaction.editReply({ embeds: [embed], components: [selectRow, skipRow] });
}

export async function handleExpansionSelect(
  interaction: StringSelectMenuInteraction,
  draftId: string,
): Promise<void> {
  await interaction.deferUpdate();
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.', embeds: [], components: [] });
    return;
  }

  const selectedExpansions = interaction.values.map((bggId) => {
    const found = draft.availableExpansions?.find((e) => e.bggId === bggId);
    return { bggId, name: found?.name ?? bggId };
  });

  const updated = updateDraft(draftId, { expansions: selectedExpansions })!;

  if (draft.listingType === 'sell') {
    await showPriceScreen(interaction, updated, draftId);
  } else {
    await createTradeListing(interaction, updated);
  }
}

export async function handleSkipExpansions(
  interaction: ButtonInteraction,
  draftId: string,
): Promise<void> {
  await interaction.deferUpdate();
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.', embeds: [], components: [] });
    return;
  }
  if (draft.listingType === 'sell') {
    await showPriceScreen(interaction, draft, draftId);
  } else {
    await createTradeListing(interaction, draft);
  }
}

async function showIncludeBaseGameSelect(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  draft: SellDraft,
  draftId: string,
): Promise<void> {
  const parentItem = draft.parentItem!;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mp_base_yes_${draftId}`).setLabel(`✅ Include ${parentItem.name}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mp_base_no_${draftId}`).setLabel('➡️ Just the Expansion').setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${draft.itemName} is an expansion`)
    .setDescription(
      `This is an expansion for **${parentItem.name}**. Are you including the base game in this listing, ` +
      `or just the expansion by itself?`,
    );
  if (draft.thumbnail) embed.setThumbnail(draft.thumbnail);

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function continueAfterBaseGameChoice(
  interaction: ButtonInteraction,
  draft: SellDraft,
  draftId: string,
): Promise<void> {
  if (draft.listingType === 'sell') {
    await showPriceScreen(interaction, draft, draftId);
  } else {
    await createTradeListing(interaction, draft);
  }
}

export async function handleIncludeBaseGameYes(
  interaction: ButtonInteraction,
  draftId: string,
): Promise<void> {
  await interaction.deferUpdate();
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.', embeds: [], components: [] });
    return;
  }
  const updated = updateDraft(draftId, { includesBaseGame: true })!;
  await continueAfterBaseGameChoice(interaction, updated, draftId);
}

export async function handleIncludeBaseGameNo(
  interaction: ButtonInteraction,
  draftId: string,
): Promise<void> {
  await interaction.deferUpdate();
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.', embeds: [], components: [] });
    return;
  }
  const updated = updateDraft(draftId, { includesBaseGame: false })!;
  await continueAfterBaseGameChoice(interaction, updated, draftId);
}

async function showPriceScreen(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  draft: SellDraft,
  draftId: string,
): Promise<void> {
  const { itemName, bggId, thumbnail, condition, expansions, isExpansion, parentItem, includesBaseGame, priceCheckOnly, matchNote } = draft;
  const expansionCount = expansions?.length ?? 0;
  const includeBase = !!(includesBaseGame && parentItem);
  const bundleExtras = [...(expansions ?? []), ...(includeBase ? [parentItem!] : [])];
  const hasBundle = bundleExtras.length > 0;
  const titleLabel = bundleDisplayTitle(itemName, expansionCount, includeBase);
  let suggestedPrice: number | undefined;

  const priceEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(priceCheckOnly ? `Price check — ${titleLabel}` : `Set a price for ${titleLabel}`)
    .setDescription(matchNote ? `${matchNote}\n\nPick an option below.` : 'Pick an option below.');

  if (!priceCheckOnly) {
    priceEmbed.addFields({ name: 'Condition', value: CONDITION_LABELS[condition], inline: true });
  }

  if (thumbnail) priceEmbed.setThumbnail(thumbnail);

  if (bggId) {
    if (hasBundle) {
      // Fetch prices for the primary item and all bundle extras (expansions and/or the base game) in parallel
      const allIds = [bggId, ...bundleExtras.map((e) => e.bggId)];
      const allNames = [itemName, ...bundleExtras.map((e) => e.name)];
      const allPrices = await Promise.all(
        allIds.map((id) => fetchBGGMarketplacePrices(id).catch(() => null)),
      );

      let combinedMedian = 0;
      let hasAnyData = false;
      let totalListings = 0;
      const priceFields: { name: string; value: string; inline?: boolean }[] = [];

      for (let i = 0; i < allIds.length; i++) {
        const p = allPrices[i];
        const label = i === 0 ? (isExpansion ? allNames[i] : `Base — ${allNames[i]}`) : allNames[i];
        if (p && p.listings.length > 0) {
          hasAnyData = true;
          totalListings += p.listings.length;
          if (p.p50 != null) combinedMedian += p.p50;
          priceFields.push({
            name: label,
            value: [
              `Range: **${p.p25 != null ? formatPrice(p.p25) : '?'} – ${p.p75 != null ? formatPrice(p.p75) : '?'}** · Median: **${p.p50 != null ? formatPrice(p.p50) : '?'}**`,
              `${p.listings.length} active listing${p.listings.length > 1 ? 's' : ''} on BoardGameGeek`,
            ].join('\n'),
          });
        } else {
          priceFields.push({ name: label, value: '*No BoardGameGeek listings found*' });
        }
      }

      if (hasAnyData) {
        suggestedPrice = Math.round(combinedMedian * 100) / 100;
        const desc = priceCheckOnly
          ? `Current BoardGameGeek marketplace prices — ${totalListings} listing${totalListings !== 1 ? 's' : ''} total across all items.`
          : `Here's what each item is currently selling for on BoardGameGeek — pick a price for the bundle below.`;
        priceEmbed.setDescription(desc).addFields(...priceFields);
        if (suggestedPrice > 0) {
          priceEmbed.addFields({ name: 'Combined estimate', value: `**${formatPrice(suggestedPrice)}**`, inline: true });
        }
      } else {
        priceEmbed.addFields({ name: 'BoardGameGeek Marketplace', value: '*No active listings found for any of these items.*' });
      }
    } else {
      // Single item — show histogram
      const marketPrices = await fetchBGGMarketplacePrices(bggId).catch(() => null);
      if (marketPrices && marketPrices.listings.length > 0) {
        suggestedPrice = marketPrices.p50 ?? marketPrices.avgPrice ?? undefined;
        const values = marketPrices.listings.map((l) => l.value);
        const histogram = buildPriceHistogram(values);
        const desc = priceCheckOnly
          ? `Current BoardGameGeek marketplace prices — ${marketPrices.listings.length} active listing${marketPrices.listings.length > 1 ? 's' : ''}.`
          : 'Here\'s what this item is currently selling for on BoardGameGeek — pick an option below.';
        priceEmbed
          .setDescription(desc)
          .addFields(
            {
              name: `BoardGameGeek Marketplace — ${marketPrices.listings.length} active listing${marketPrices.listings.length > 1 ? 's' : ''}`,
              value: [
                `**Typical range: ${marketPrices.p25 != null ? formatPrice(marketPrices.p25) : '?'} – ${marketPrices.p75 != null ? formatPrice(marketPrices.p75) : '?'}** (middle 50%)`,
                `Median: **${marketPrices.p50 != null ? formatPrice(marketPrices.p50) : '?'}** · Avg: ${marketPrices.avgPrice != null ? formatPrice(marketPrices.avgPrice) : '?'}`,
              ].join('\n'),
            },
            { name: 'Price distribution', value: histogram || '*Not enough data*' },
          );
      } else {
        priceEmbed.addFields({ name: 'BoardGameGeek Marketplace', value: '*No active listings found on BoardGameGeek — no price data available.*' });
      }
    }
  }

  // Store the suggested price back into the draft so button handlers can read it
  updateDraft(draftId, { suggestedPrice });

  if (priceCheckOnly) {
    const bggAttachment = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');
    priceEmbed.setImage('attachment://powered_by_BGG_01_SM.png');
    await interaction.editReply({ embeds: [priceEmbed], files: [bggAttachment], components: [] });
    return;
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(suggestedPrice != null
      ? [new ButtonBuilder().setCustomId(`mp_price_use_${draftId}`).setLabel(`Use ${formatPrice(suggestedPrice)}${hasBundle ? ' (combined estimate)' : ' (median)'}`).setStyle(ButtonStyle.Success)]
      : []),
    new ButtonBuilder().setCustomId(`mp_price_custom_${draftId}`).setLabel('Enter my own price').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mp_price_none_${draftId}`).setLabel('List as open to offers').setStyle(ButtonStyle.Secondary),
  );

  const bggAttachment = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');
  priceEmbed.setImage('attachment://powered_by_BGG_01_SM.png');
  await interaction.editReply({ embeds: [priceEmbed], files: [bggAttachment], components: [buttons] });
}

async function showNoBggPrompt(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  itemName: string,
  draftId: string,
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mp_ref_add_${draftId}`).setLabel('Add a link').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mp_ref_skip_${draftId}`).setLabel('Continue without').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    content: `**${itemName}** wasn't found on BoardGameGeek. Would you like to add a reference image URL or link before posting?`,
    components: [row],
  });
}

async function finalizeSellListing(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  draft: Omit<SellDraft, 'expiresAt'>,
  price: number | undefined,
): Promise<void> {
  const { guildId, userId, username, itemName, bggId, thumbnail, condition, notes, referenceLink, bidsAllowed, expansions, parentItem, includesBaseGame } = draft;

  const listing = await createListing(guildId, {
    guildId,
    userId,
    username,
    type: 'sell',
    bggId,
    itemName,
    thumbnail,
    condition,
    notes,
    referenceLink,
    askingPrice: price,
    bidsAllowed,
    expansions: expansions && expansions.length > 0 ? expansions : undefined,
    parentItem,
    includesBaseGame,
  });

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'listing_created',
    listingId: listing.id,
    listingName: listing.itemName,
    listingType: 'sell',
    actorId: userId,
    actorUsername: username,
    amount: price,
    details: `condition=${condition} bidsAllowed=${bidsAllowed}`,
  });

  let listingPosted = false;
  const posted = await postListingToChannel(listing, guildId, interaction.client);
  if (posted) {
    await updateListing(guildId, listing.id, posted);
    listingPosted = true;
  }
  const postedLink = posted ? listingLink(posted, guildId) : undefined;

  const responseEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`Listing created — ${itemName}`)
    .addFields(
      { name: 'Price', value: price != null ? formatPrice(price) : 'Open to offers', inline: true },
      { name: 'Negotiable?', value: bidsAllowed ? '💬 Open to Offers' : '🔒 Firm Price', inline: true },
      { name: 'Condition', value: CONDITION_LABELS[condition], inline: true },
      { name: 'Listing ID', value: `\`${listing.id}\``, inline: false },
      ...(postedLink ? [{ name: 'Marketplace Post', value: `[View listing](${postedLink})`, inline: false }] : []),
    )
    .setFooter({ text: listingPosted ? 'Posted to marketplace channel.' : 'No marketplace channel configured — use /admin marketplace config to set one.' });

  if (thumbnail) responseEmbed.setThumbnail(thumbnail);

  const replyPayload = { embeds: [responseEmbed], components: [] };
  if ('editReply' in interaction && typeof (interaction as ChatInputCommandInteraction).editReply === 'function') {
    await (interaction as ChatInputCommandInteraction).editReply(replyPayload);
  } else if ('update' in interaction && typeof (interaction as ButtonInteraction).update === 'function') {
    await (interaction as ButtonInteraction).update(replyPayload);
  }
}

// ── /marketplace post trade ─────────────────────────────────────────────────

async function handlePostTrade(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rawItem = interaction.options.getString('item', true);
  const condition = interaction.options.getString('condition', true) as Condition;
  const lookingFor = interaction.options.getString('looking_for') ?? undefined;
  const notes = interaction.options.getString('notes') ?? undefined;
  const guildId = interaction.guildId!;

  if (rawItem === '__placeholder__') {
    await interaction.editReply({ content: 'Please type an item name and select an option from the list.' });
    return;
  }

  const username = interaction.member
    ? (interaction.member as { displayName?: string }).displayName ?? interaction.user.username
    : interaction.user.username;

  await createTradeDraftAndContinue(
    interaction,
    guildId,
    interaction.user.id,
    username,
    rawItem,
    condition,
    notes,
    lookingFor,
  );
}

// Shared by the slash command above, the marketplace hub's Trade wizard (see
// handleHubMarketplaceConditionSelect below), and "search again" on the
// match-confirmation prompt — see createSellDraftAndContinue above for how
// rawItem gets resolved.
async function createTradeDraftAndContinue(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  guildId: string,
  userId: string,
  username: string,
  rawItem: string,
  condition: Condition,
  notes: string | undefined,
  lookingFor: string | undefined,
): Promise<void> {
  const resolution = await resolveMarketplaceItem(rawItem);

  const draft: Omit<SellDraft, 'expiresAt'> = {
    listingType: 'trade',
    guildId,
    userId,
    username,
    itemName: resolution.itemName,
    bggId: resolution.bggId,
    thumbnail: resolution.thumbnail,
    isExpansion: resolution.isExpansion,
    availableExpansions: resolution.availableExpansions,
    parentItem: resolution.parentItem,
    condition,
    notes,
    bidsAllowed: true,
    lookingFor,
  };

  const draftId = storeDraft(draft);
  const stored = sellDrafts.get(draftId)!;

  if (stored.bggId && !resolution.confident && resolution.matchedName) {
    await showConfirmMatchPrompt(interaction, stored, draftId, resolution.matchedName, resolution.matchedYear);
    return;
  }
  await continueAfterItemResolved(interaction, stored, draftId);
}

// ── /marketplace price ───────────────────────────────────────────────────────

async function handlePriceCheck(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rawItem = interaction.options.getString('item', true);

  if (rawItem === '__placeholder__') {
    await interaction.editReply({ content: 'Please type an item name and select an option from the list.' });
    return;
  }

  if (rawItem.startsWith('__custom__:')) {
    const itemName = rawItem.slice('__custom__:'.length);
    await interaction.editReply({ content: `**${itemName}** is not in the BGG catalog — no marketplace price data available for custom items.` });
    return;
  }

  const resolution = await resolveMarketplaceItem(rawItem);
  if (!resolution.bggId) {
    await interaction.editReply({ content: `No BGG entry found for **${resolution.itemName}** — can't look up pricing.` });
    return;
  }

  const draft: Omit<SellDraft, 'expiresAt'> = {
    listingType: 'sell',
    guildId: interaction.guildId!,
    userId: interaction.user.id,
    username: '',
    itemName: resolution.itemName,
    bggId: resolution.bggId,
    thumbnail: resolution.thumbnail,
    isExpansion: resolution.isExpansion,
    availableExpansions: resolution.availableExpansions,
    parentItem: resolution.parentItem,
    condition: 'good',
    bidsAllowed: false,
    priceCheckOnly: true,
    // No interactive confirmation step for price check (read-only, lower
    // stakes) — just surface an unconfirmed guess in the embed instead of
    // silently showing prices for the wrong game.
    matchNote: !resolution.confident && resolution.matchedName
      ? `⚠️ Best-guess match for "${rawItem}" — showing prices for **${resolution.matchedName}**${resolution.matchedYear ? ` (${resolution.matchedYear})` : ''}.`
      : undefined,
  };

  const draftId = storeDraft(draft);
  const stored = sellDrafts.get(draftId)!;

  if (!resolution.isExpansion && resolution.availableExpansions.length > 0) {
    await showExpansionSelect(interaction, stored, draftId);
  } else if (resolution.isExpansion && resolution.parentItem) {
    await showIncludeBaseGameSelect(interaction, stored, draftId);
  } else {
    await showPriceScreen(interaction, stored, draftId);
  }
}

async function createTradeListing(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  draft: Omit<SellDraft, 'expiresAt'>,
): Promise<void> {
  const { guildId, userId, username, itemName, bggId, thumbnail, condition, notes, referenceLink, lookingFor, expansions, parentItem, includesBaseGame } = draft;

  const listing = await createListing(guildId, {
    guildId, userId, username,
    type: 'trade',
    bggId, itemName, thumbnail, condition, notes, referenceLink,
    bidsAllowed: true,
    lookingFor,
    expansions: expansions && expansions.length > 0 ? expansions : undefined,
    parentItem,
    includesBaseGame,
  });

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'listing_created',
    listingId: listing.id,
    listingName: listing.itemName,
    listingType: 'trade',
    actorId: userId,
    actorUsername: username,
    details: `condition=${condition}`,
  });

  let listingPosted = false;
  const posted = await postListingToChannel(listing, guildId, interaction.client);
  if (posted) {
    await updateListing(guildId, listing.id, posted);
    listingPosted = true;
  }
  const postedLink = posted ? listingLink(posted, guildId) : undefined;

  const responseEmbed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Trade listing created — ${listing.itemName}`)
    .addFields(
      { name: 'Offering', value: listing.itemName, inline: true },
      { name: 'Looking For', value: lookingFor ?? 'Open to offers', inline: true },
      { name: 'Condition', value: CONDITION_LABELS[condition], inline: true },
      { name: 'Listing ID', value: `\`${listing.id}\``, inline: false },
      ...(postedLink ? [{ name: 'Marketplace Post', value: `[View listing](${postedLink})`, inline: false }] : []),
    )
    .setFooter({ text: listingPosted ? 'Posted to marketplace channel.' : 'No marketplace channel configured.' });

  await interaction.editReply({ embeds: [responseEmbed] });
}

// ── /marketplace conditions ──────────────────────────────────────────────────

async function handleConditions(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Marketplace Condition Guide')
    .setDescription('Use these grades when listing items for sale or trade.')
    .addFields(
      {
        name: '🆕 New',
        value: 'Brand new, unused, unopened, and undamaged. Original packaging and all materials are in perfect condition.',
      },
      {
        name: '✨ Like New',
        value: 'Just removed from shrink wrap. No wear and tear, all components intact.',
      },
      {
        name: '👍 Very Good',
        value: 'Very minimal wear and tear. All materials present. You would give this to a friend as a gift.',
      },
      {
        name: '👌 Good',
        value: 'Minor damage to the box and/or contents. All materials present. May have been used once or twice.',
      },
      {
        name: '🟠 Acceptable',
        value: 'Some box damage but item is intact. Possible split corners. May be missing a non-crucial piece or rules (available online). Scuffing on the item.',
      },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ── /marketplace browse ─────────────────────────────────────────────────────

async function handleBrowse(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  // The hub's "Browse Listings" button has no type filter — it always shows everything.
  const typeFilter = interaction.isChatInputCommand() ? (interaction.options.getString('type') as 'sell' | 'trade' | null) : null;

  let listings = await getActiveListingsForGuild(guildId);
  if (typeFilter) listings = listings.filter((l) => l.type === typeFilter);

  if (listings.length === 0) {
    await interaction.editReply({ content: 'No active listings found.' });
    return;
  }

  const PAGE_SIZE = 5;
  const page = listings.slice(0, PAGE_SIZE);
  const lines = page.map((l) => {
    const typeIcon = l.type === 'sell' ? '🏷️' : '🔄';
    const statusIcon = l.status === 'pending' ? '🟡' : '🟢';
    const priceStr = l.type === 'sell'
      ? (l.askingPrice != null ? formatPrice(l.askingPrice) : 'Open to offers')
      : (l.lookingFor ?? 'Open to offers');
    const openOffers = l.bids.filter((b) => b.status === 'open').length;
    const link = listingLink(l, guildId);
    const threadLink = link ? ` — [View listing](${link})` : '';
    return `${statusIcon} ${typeIcon} **${l.itemName}** — ${priceStr}${openOffers > 0 ? ` *(${openOffers} offer${openOffers > 1 ? 's' : ''})*` : ''} — by ${l.username}${threadLink}`;
  });

  const moreNote = listings.length > PAGE_SIZE
    ? `\n\n*Showing ${PAGE_SIZE} of ${listings.length}. Check the marketplace channel for all listings.*`
    : '';

  await interaction.editReply({
    content: `**Active Marketplace Listings**\n\n${lines.join('\n')}${moreNote}`,
  });
}

// ── /marketplace my ─────────────────────────────────────────────────────────

async function handleMy(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const listings = await getUserListings(guildId, interaction.user.id);

  if (listings.length === 0) {
    await interaction.editReply({ content: "You don't have any listings. Use `/marketplace post` to create one." });
    return;
  }

  const lines = listings.map((l) => {
    const typeIcon = l.type === 'sell' ? '🏷️' : '🔄';
    const statusEmoji: Record<string, string> = { active: '🟢', pending: '🟡', sold: '🔴', closed: '⚫' };
    const priceStr = l.type === 'sell'
      ? (l.askingPrice != null ? formatPrice(l.askingPrice) : 'Open to offers')
      : (l.lookingFor ?? 'Open to offers');
    const openOffers = l.bids.filter((b) => b.status === 'open').length;
    return `${statusEmoji[l.status]} ${typeIcon} **${l.itemName}** — ${priceStr}${openOffers > 0 ? ` *(${openOffers} open offer${openOffers > 1 ? 's' : ''})*` : ''}\n  ID: \`${l.id}\``;
  });

  await interaction.editReply({
    content: `**Your Listings**\n\n${lines.join('\n\n')}\n\nUse \`/marketplace close <id>\` to close a listing, or \`/marketplace reopen <id>\` to reopen one.`,
  });
}

// ── /marketplace close ──────────────────────────────────────────────────────

async function handleClose(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const listingId = interaction.options.getString('id', true).trim();
  const listing = await getListing(guildId, listingId);

  if (!listing) {
    await interaction.editReply({ content: 'Listing not found.' });
    return;
  }

  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (listing.userId !== interaction.user.id && !isAdmin) {
    await interaction.editReply({ content: 'You can only close your own listings.' });
    return;
  }

  const updated = await closeListing(guildId, listingId);
  if (!updated) {
    await interaction.editReply({ content: 'Could not close listing.' });
    return;
  }

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'listing_closed',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
  });

  await updateListingPost(updated, interaction.client, guildId);
  await interaction.editReply({ content: `Listing **${listing.itemName}** has been closed.` });
}

// ── /marketplace reopen ─────────────────────────────────────────────────────

async function handleReopen(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const listingId = interaction.options.getString('id', true).trim();
  const listing = await getListing(guildId, listingId);

  if (!listing) {
    await interaction.editReply({ content: 'Listing not found.' });
    return;
  }

  if (listing.userId !== interaction.user.id) {
    await interaction.editReply({ content: 'You can only reopen your own listings.' });
    return;
  }

  const updated = await reopenListing(guildId, listingId);
  if (!updated) {
    await interaction.editReply({ content: 'Could not reopen listing.' });
    return;
  }

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'listing_reopened',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
  });

  await updateListingPost(updated, interaction.client, guildId);
  await interaction.editReply({ content: `Listing **${listing.itemName}** has been reopened and is now ${updated.status}.` });
}

// ── "Quick Actions" button hub ────────────────────────────────────────────────
// Unlike the per-event/per-room hubs, the marketplace forum is one shared
// channel per guild — so the hub lives as a single **pinned forum post**
// (thread) rather than a plain pinned message, using discord.js's ThreadChannel
// pin()/unpin() (forum-only; backed by Discord's ChannelFlags.Pinned bit).

export function buildMarketplaceHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎮 Quick Actions')
    .setColor(0x57f287)
    .setDescription('Prefer tapping over typing? Use the buttons below instead of slash commands.')
    .addFields(
      { name: '📦 Sell an Item', value: 'List something you want to sell.' },
      { name: '🔄 Propose a Trade', value: "List something you'd trade away." },
      { name: '🔍 Browse Listings', value: 'See what other members are selling or trading.' },
      { name: '📋 My Listings', value: 'See your own active listings and offers.' },
    );
}

export function buildMarketplaceHubButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('hub_mp_sell').setLabel('📦 Sell an Item').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub_mp_trade').setLabel('🔄 Propose a Trade').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub_mp_browse').setLabel('🔍 Browse Listings').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('hub_mp_my').setLabel('📋 My Listings').setStyle(ButtonStyle.Secondary),
  );
}

// Called whenever the marketplace channel is (re)configured via /admin
// marketplace config — analogous to the eager tag creation right after this
// call, so the hub is ready before any listing is ever posted.
export async function updateMarketplaceHubThread(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config.marketplaceChannelId) return;

  let forumChannel: ForumChannel;
  try {
    const ch = await client.channels.fetch(config.marketplaceChannelId);
    if (ch?.type !== ChannelType.GuildForum) return;
    forumChannel = ch as ForumChannel;
  } catch {
    return;
  }

  const payload = { embeds: [buildMarketplaceHubEmbed()], components: [buildMarketplaceHubButtons()] };

  if (config.marketplaceHubThreadId) {
    try {
      const thread = await forumChannel.threads.fetch(config.marketplaceHubThreadId);
      if (thread) {
        const starterMsg = await thread.fetchStarterMessage();
        if (starterMsg) await starterMsg.edit(payload);
        if (!thread.flags.has(ChannelFlags.Pinned)) {
          await pinWithRetry(thread, `re-pin marketplace hub thread in guild ${guildId}`);
        }
        return;
      }
    } catch {
      /* thread was deleted — fall through and recreate */
    }
  }

  let thread: ThreadChannel;
  try {
    thread = await forumChannel.threads.create({ name: '🎮 Quick Actions', message: payload });
  } catch (err) {
    console.warn(`Could not create marketplace hub thread in guild ${guildId}:`, err);
    return;
  }
  await pinWithRetry(thread, `marketplace hub thread in guild ${guildId}`);

  await updateGuildConfig(guildId, { marketplaceHubThreadId: thread.id });
}

// Text-channel equivalent of updateMarketplaceHubThread — same Quick Actions
// embed/buttons, but as a plain pinned message (Text channels have no forum
// threads to pin), tracked via marketplaceHubMessageId instead of
// marketplaceHubThreadId. Modeled on updateHubPin in src/utils/requestPin.ts.
export async function updateMarketplaceHubMessage(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config.marketplaceChannelId) return;

  let textChannel: TextChannel;
  try {
    const ch = await client.channels.fetch(config.marketplaceChannelId);
    if (ch?.type !== ChannelType.GuildText) return;
    textChannel = ch as TextChannel;
  } catch {
    return;
  }

  const payload = { embeds: [buildMarketplaceHubEmbed()], components: [buildMarketplaceHubButtons()] };

  if (config.marketplaceHubMessageId) {
    try {
      const msg = await textChannel.messages.fetch(config.marketplaceHubMessageId);
      await msg.edit(payload);
      if (!msg.pinned) {
        await pinWithRetry(msg, `re-pin marketplace hub message in guild ${guildId}`);
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await textChannel.send(payload);
  await pinWithRetry(msg, `marketplace hub message in guild ${guildId}`);

  await updateGuildConfig(guildId, { marketplaceHubMessageId: msg.id });
}

// ── Marketplace listing index (Text-channel mode) ───────────────────────────
// Substitutes for forum tags' status/type filtering: a single pinned message
// listing every active listing grouped by type, each linking to its post.
// Modeled on buildGameListEmbed/updateGameListPin in src/utils/requestPin.ts.

function buildMarketplaceListingIndexEmbed(guildId: string, listings: MarketplaceListing[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('🛒 Marketplace Listings').setColor(0x5865f2);
  if (listings.length === 0) {
    return embed.setDescription('No active listings right now — use `/marketplace post sell` or `post trade` to list something.');
  }

  const lineFor = (l: MarketplaceListing) => {
    const priceStr = l.type === 'sell'
      ? (l.askingPrice != null ? formatPrice(l.askingPrice) : 'Open to offers')
      : (l.lookingFor ?? 'Open to offers');
    const statusIcon = l.status === 'pending' ? '🟡' : '🟢';
    const link = listingLink(l, guildId);
    const title = link ? `[${l.itemName}](${link})` : l.itemName;
    return `${statusIcon} **${title}** — ${priceStr} — by ${l.username}`;
  };

  const sellLines = listings.filter((l) => l.type === 'sell').map(lineFor);
  const tradeLines = listings.filter((l) => l.type === 'trade').map(lineFor);
  if (sellLines.length > 0) {
    embed.addFields({ name: '🏷️ For Sale', value: sellLines.join('\n').slice(0, 1024) });
  }
  if (tradeLines.length > 0) {
    embed.addFields({ name: '🔄 For Trade', value: tradeLines.join('\n').slice(0, 1024) });
  }

  return embed.setFooter({
    text: `${listings.length} active listing${listings.length !== 1 ? 's' : ''} · Post yours with /marketplace post or the Quick Actions buttons above`,
  });
}

async function updateMarketplaceListingIndex(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config.marketplaceChannelId) return;

  let textChannel: TextChannel;
  try {
    const ch = await client.channels.fetch(config.marketplaceChannelId);
    if (ch?.type !== ChannelType.GuildText) return;
    textChannel = ch as TextChannel;
  } catch {
    return;
  }

  const listings = await getActiveListingsForGuild(guildId);
  const embed = buildMarketplaceListingIndexEmbed(guildId, listings);

  if (config.marketplaceListingIndexMessageId) {
    try {
      const msg = await textChannel.messages.fetch(config.marketplaceListingIndexMessageId);
      await msg.edit({ embeds: [embed] });
      if (!msg.pinned) {
        await pinWithRetry(msg, `re-pin marketplace listing index in guild ${guildId}`);
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await textChannel.send({ embeds: [embed] });
  await pinWithRetry(msg, `marketplace listing index in guild ${guildId}`);

  await updateGuildConfig(guildId, { marketplaceListingIndexMessageId: msg.id });
}

// ── Hub wizard: "📦 Sell an Item" / "🔄 Propose a Trade" ────────────────────
// A modal collects only the item name (no autocomplete is possible in a
// modal), then condition (native select) and — sell only — offers-allowed
// (native buttons) are collected as separate steps before handing off to the
// exact same createSellDraftAndContinue/createTradeDraftAndContinue used by
// the slash commands. Trades skip the offers-allowed step entirely (trades
// are always open to offers, mirroring /marketplace post trade).

function buildHubItemNameModal(customId: string, title: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('item')
          .setLabel('Item name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Wingspan')
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
}

export async function handleHubMarketplaceSellButton(interaction: ButtonInteraction): Promise<void> {
  await interaction.showModal(buildHubItemNameModal('hub_mp_sell_modal', 'Sell an Item'));
}

export async function handleHubMarketplaceTradeButton(interaction: ButtonInteraction): Promise<void> {
  await interaction.showModal(buildHubItemNameModal('hub_mp_trade_modal', 'Propose a Trade'));
}

async function showHubConditionSelect(interaction: ModalSubmitInteraction): Promise<void> {
  const select = new StringSelectMenuBuilder()
    .setCustomId('hub_mp_condition_select')
    .setPlaceholder("Select the item's condition…")
    .addOptions(
      (Object.keys(CONDITION_LABELS) as Condition[]).map((value) => ({
        label: CONDITION_LABELS[value],
        value,
      })),
    );
  await interaction.reply({
    content: 'What condition is it in?',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHubMarketplaceSellModal(interaction: ModalSubmitInteraction): Promise<void> {
  const itemName = interaction.fields.getTextInputValue('item').trim();
  pendingHubListings.set(interaction.user.id, { listingType: 'sell', itemName });
  await showHubConditionSelect(interaction);
}

export async function handleHubMarketplaceTradeModal(interaction: ModalSubmitInteraction): Promise<void> {
  const itemName = interaction.fields.getTextInputValue('item').trim();
  pendingHubListings.set(interaction.user.id, { listingType: 'trade', itemName });
  await showHubConditionSelect(interaction);
}

function hubDisplayName(interaction: { member: unknown; user: { username: string } }): string {
  return interaction.member
    ? ((interaction.member as { displayName?: string }).displayName ?? interaction.user.username)
    : interaction.user.username;
}

export async function handleHubMarketplaceConditionSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const pending = pendingHubListings.get(interaction.user.id);
  if (!pending) {
    await interaction.update({
      content: 'This session has expired — tap a button in Quick Actions to start again.',
      components: [],
    });
    return;
  }
  const condition = interaction.values[0] as Condition;

  if (pending.listingType === 'trade') {
    pendingHubListings.delete(interaction.user.id);
    await interaction.deferUpdate();
    await createTradeDraftAndContinue(
      interaction,
      interaction.guildId!,
      interaction.user.id,
      hubDisplayName(interaction),
      pending.itemName,
      condition,
      undefined,
      undefined,
    );
    return;
  }

  pendingHubListings.set(interaction.user.id, { ...pending, condition });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('hub_mp_offers_yes').setLabel('✅ Allow Offers').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('hub_mp_offers_no').setLabel('🔒 Firm Price').setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    content: 'Should other members be able to make offers, or is the price firm?',
    components: [row],
  });
}

async function handleHubMarketplaceOffers(interaction: ButtonInteraction, bidsAllowed: boolean): Promise<void> {
  const pending = pendingHubListings.get(interaction.user.id);
  if (!pending || pending.listingType !== 'sell' || !pending.condition) {
    await interaction.update({
      content: 'This session has expired — tap a button in Quick Actions to start again.',
      components: [],
    });
    return;
  }
  pendingHubListings.delete(interaction.user.id);
  await interaction.deferUpdate();

  await createSellDraftAndContinue(
    interaction,
    interaction.guildId!,
    interaction.user.id,
    hubDisplayName(interaction),
    pending.itemName,
    pending.condition,
    undefined,
    bidsAllowed,
  );
}

export async function handleHubMarketplaceOffersYes(interaction: ButtonInteraction): Promise<void> {
  await handleHubMarketplaceOffers(interaction, true);
}

export async function handleHubMarketplaceOffersNo(interaction: ButtonInteraction): Promise<void> {
  await handleHubMarketplaceOffers(interaction, false);
}

// ── Hub buttons: "🔍 Browse Listings" / "📋 My Listings" ────────────────────
// Run the exact same logic as their slash-command equivalents, minus the
// optional type filter (browse) that only the slash command's option exposes.

export async function handleHubMarketplaceBrowseButton(interaction: ButtonInteraction): Promise<void> {
  await handleBrowse(interaction);
}

export async function handleHubMarketplaceMyButton(interaction: ButtonInteraction): Promise<void> {
  await handleMy(interaction);
}

// ── /admin marketplace config ───────────────────────────────────────────────

export async function handleAdminConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!isAdmin) {
    await interaction.editReply({ content: 'This command requires Manage Server permission.' });
    return;
  }

  const guildId = interaction.guildId!;
  const channel = interaction.options.getChannel('channel');
  const mode = interaction.options.getString('negotiation_mode') as 'public' | 'private' | null;

  const patch: Record<string, unknown> = {};
  if (channel) {
    if (channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: 'The marketplace channel must be a **Forum Channel** or a **Text Channel**.' });
      return;
    }
    patch.marketplaceChannelId = channel.id;
  }
  if (mode) patch.marketplaceNegotiationMode = mode;

  if (Object.keys(patch).length === 0) {
    const config = await getGuildConfig(guildId);
    await interaction.editReply({
      content: [
        '**Current marketplace config:**',
        `• Channel: ${config.marketplaceChannelId ? `<#${config.marketplaceChannelId}>` : '*not set*'}`,
        `• Negotiation mode: **${config.marketplaceNegotiationMode}**`,
      ].join('\n'),
    });
    return;
  }

  await updateGuildConfig(guildId, patch as Parameters<typeof updateGuildConfig>[1]);
  const config = await getGuildConfig(guildId);

  // Eagerly set up the mode-appropriate ready-to-go pieces (forum tags + hub
  // thread, or hub message + listing index) so they're ready before any
  // listing is ever posted, rather than being created lazily on first use.
  let setupNote = '';
  if (patch.marketplaceChannelId && config.marketplaceChannelId) {
    try {
      const channel = await interaction.client.channels.fetch(config.marketplaceChannelId);
      if (channel?.type === ChannelType.GuildForum) {
        await ensureMarketplaceTags(channel as ForumChannel, guildId);
        await updateMarketplaceHubThread(interaction.client, guildId).catch(() => null);
        setupNote = '\n✅ Forum tags created/verified and Quick Actions hub posted.';
      } else if (channel?.type === ChannelType.GuildText) {
        await updateMarketplaceHubMessage(interaction.client, guildId).catch(() => null);
        await updateMarketplaceListingIndex(interaction.client, guildId).catch(() => null);
        setupNote = '\n✅ Quick Actions hub and listing index posted.';
      }
    } catch {
      // non-fatal — hub/index will be created lazily on first listing post
    }
  }

  await interaction.editReply({
    content: [
      'Marketplace config updated.',
      `• Channel: ${config.marketplaceChannelId ? `<#${config.marketplaceChannelId}>` : '*not set*'}`,
      `• Negotiation mode: **${config.marketplaceNegotiationMode}**`,
      setupNote,
    ].join('\n'),
  });
}

// ── /admin marketplace purge ────────────────────────────────────────────────

export async function handleAdminPurge(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!isAdmin) {
    await interaction.editReply({ content: 'This command requires Manage Server permission.' });
    return;
  }

  const guildId = interaction.guildId!;
  const targetUser = interaction.options.getUser('user');
  const statusOption = interaction.options.getString('status')
    ?? (targetUser ? 'all' : 'sold_closed');

  const statusFilter: Parameters<typeof purgeListings>[1]['status'] =
    statusOption === 'active' ? ['active'] :
    statusOption === 'active_pending' ? ['active', 'pending'] :
    statusOption === 'all' ? ['active', 'pending', 'sold', 'closed'] :
    ['sold', 'closed'];

  const allListings = await getListingsForGuild(guildId);
  const listingsToPurge = allListings.filter((l) => {
    if (targetUser && l.userId !== targetUser.id) return false;
    return statusFilter.includes(l.status);
  });

  const removed = await purgeListings(guildId, {
    userId: targetUser?.id,
    status: statusFilter,
  });

  for (const listing of listingsToPurge) {
    try {
      if (listing.forumThreadId) {
        const thread = await interaction.client.channels.fetch(listing.forumThreadId) as ThreadChannel;
        await thread?.delete('Marketplace listing purged by admin');
      } else if (listing.listingMessageId && listing.listingChannelId) {
        const channel = await interaction.client.channels.fetch(listing.listingChannelId);
        if (channel?.isTextBased()) {
          const message = await channel.messages.fetch(listing.listingMessageId).catch(() => null);
          await message?.delete();
        }
      }
    } catch {
      // thread/message already gone or inaccessible — nothing to clean up
    }
  }
  await updateMarketplaceListingIndex(interaction.client, guildId).catch(() => null);

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'admin_purge',
    listingId: 'bulk',
    listingName: 'bulk',
    listingType: 'sell',
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
    details: `purged ${removed} listings, status=${statusOption}, userId=${targetUser?.id ?? 'all'}`,
  });

  const scope = targetUser ? ` from ${targetUser.username}` : '';
  await interaction.editReply({
    content: `Purged **${removed}** listing${removed !== 1 ? 's' : ''}${scope} (filter: ${statusOption}).`,
  });
}

// ── execute ─────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === 'post') {
    if (sub === 'sell') await handlePostSell(interaction);
    else if (sub === 'trade') await handlePostTrade(interaction);
  } else {
    if (sub === 'browse') await handleBrowse(interaction);
    else if (sub === 'my') await handleMy(interaction);
    else if (sub === 'price') await handlePriceCheck(interaction);
    else if (sub === 'conditions') await handleConditions(interaction);
    else if (sub === 'close') await handleClose(interaction);
    else if (sub === 'reopen') await handleReopen(interaction);
  }
}

// ── Price suggestion buttons ─────────────────────────────────────────────────

export async function handlePriceUseSuggested(interaction: ButtonInteraction, draftId: string): Promise<void> {
  const draft = takeDraft(draftId);
  if (!draft || draft.userId !== interaction.user.id) {
    await interaction.update({ content: 'This price selection has expired. Please run `/marketplace post sell` again.', embeds: [], components: [] });
    return;
  }
  await interaction.deferUpdate();
  await finalizeSellListing(interaction, draft, draft.suggestedPrice);
}

export async function handlePriceNone(interaction: ButtonInteraction, draftId: string): Promise<void> {
  const draft = takeDraft(draftId);
  if (!draft || draft.userId !== interaction.user.id) {
    await interaction.update({ content: 'This price selection has expired. Please run `/marketplace post sell` again.', embeds: [], components: [] });
    return;
  }
  await interaction.deferUpdate();
  await finalizeSellListing(interaction, draft, undefined);
}

export async function handlePriceCustomButton(interaction: ButtonInteraction, draftId: string): Promise<void> {
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id || draft.expiresAt < Date.now()) {
    await interaction.update({ content: 'This price selection has expired. Please run `/marketplace post sell` again.', embeds: [], components: [] });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`mp_price_modal_${draftId}`)
    .setTitle(`Set your price — ${draft.itemName}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('custom_price')
          .setLabel('Your asking price (USD)')
          .setPlaceholder(draft.suggestedPrice != null ? `BGG avg: ${formatPrice(draft.suggestedPrice)}` : 'e.g. 25.00')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

export async function handlePriceCustomModal(interaction: ModalSubmitInteraction, draftId: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const draft = takeDraft(draftId);
  if (!draft || draft.userId !== interaction.user.id) {
    await interaction.editReply({ content: 'This price selection has expired. Please run `/marketplace post sell` again.' });
    return;
  }
  const raw = interaction.fields.getTextInputValue('custom_price').trim();
  const price = parseFloat(raw.replace(/[^0-9.]/g, ''));
  if (isNaN(price) || price < 0) {
    await interaction.editReply({ content: 'Invalid price — please enter a number like `25.00`.' });
    return;
  }
  await finalizeSellListing(interaction, draft, price);
}

// ── Button: I'm Interested ──────────────────────────────────────────────────

export async function handleInterestButton(interaction: ButtonInteraction, listingId: string): Promise<void> {
  const guildId = interaction.guildId!;
  const listing = await getListing(guildId, listingId);

  if (!listing || listing.status === 'sold' || listing.status === 'closed') {
    await interaction.reply({ content: 'This listing is no longer available.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (listing.userId === interaction.user.id) {
    await interaction.reply({ content: "You can't make an offer on your own listing.", flags: MessageFlags.Ephemeral });
    return;
  }

  const existingBid = getOpenBid(listing, interaction.user.id);
  if (existingBid) {
    await interaction.reply({ content: 'You already have an open offer on this listing.', flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`mp_bid_${listingId}`)
    .setTitle(`Interested in ${listing.itemName}`.slice(0, 45));

  const components: ActionRowBuilder<TextInputBuilder>[] = [];

  if (listing.type === 'sell' && listing.bidsAllowed) {
    const priceRef = listing.askingPrice != null ? ` (asking ${formatPrice(listing.askingPrice)})` : '';
    components.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('bid_amount')
          .setLabel(`Your offer${priceRef}`)
          .setPlaceholder('Enter amount in USD, e.g. 25.00')
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
    );
  } else if (listing.type === 'trade') {
    components.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('bid_offer')
          .setLabel('What are you offering in exchange?')
          .setPlaceholder(listing.lookingFor ? `Seller wants: ${listing.lookingFor}` : 'Describe what you\'ll trade')
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
    );
  }

  components.push(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('bid_message')
        .setLabel('Message to seller (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500),
    ),
  );

  modal.addComponents(...components);
  await interaction.showModal(modal);
}

// ── Button: Buy It Now (firm listings only) ──────────────────────────────────

function buyNowConfirmRow(listingId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mp_buynowyes_${listingId}`)
      .setLabel('Confirm Purchase')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mp_buynowno_${listingId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function handleBuyNowButton(interaction: ButtonInteraction, listingId: string): Promise<void> {
  const guildId = interaction.guildId!;
  const listing = await getListing(guildId, listingId);

  if (!listing || listing.status === 'sold' || listing.status === 'closed') {
    await interaction.reply({ content: 'This listing is no longer available.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (listing.userId === interaction.user.id) {
    await interaction.reply({ content: "You can't buy your own listing.", flags: MessageFlags.Ephemeral });
    return;
  }

  const priceDisplay = listing.askingPrice != null ? formatPrice(listing.askingPrice) : 'the listed price';
  await interaction.reply({
    content: `Confirm purchase of **${listing.itemName}** for **${priceDisplay}**? This is final — the seller won't get a chance to review it first.`,
    components: [buyNowConfirmRow(listingId)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleBuyNowCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({ content: 'Purchase cancelled.', components: [] });
}

export async function handleBuyNowConfirm(interaction: ButtonInteraction, listingId: string): Promise<void> {
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const listing = await getListing(guildId, listingId);
  if (!listing || listing.status === 'sold' || listing.status === 'closed') {
    await interaction.editReply({ content: 'Sorry, this listing is no longer available.', components: [] });
    return;
  }

  const buyerName = interaction.member
    ? (interaction.member as { displayName?: string }).displayName ?? interaction.user.username
    : interaction.user.username;

  const result = await buyNow(guildId, listingId, interaction.user.id, buyerName);
  if (!result) {
    await interaction.editReply({ content: 'Sorry, this listing is no longer available — someone else may have just bought it.', components: [] });
    return;
  }

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'bid_accepted',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
    bidId: result.boughtBid.id,
    details: 'buy it now',
  });
  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'listing_sold',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
  });

  // Post visible conclusion before the listing post gets locked/finalized
  await postListingFollowup(result.listing, interaction.client, {
    content: `⚡ **Sold instantly!** <@${interaction.user.id}> bought **${listing.itemName}** with Buy It Now. Coordinate the exchange directly. This listing is now closed.`,
  });

  await updateListingPost(result.listing, interaction.client, guildId);

  try {
    const seller = await interaction.client.users.fetch(listing.userId);
    const inLibrary = (await getGamesByUser(guildId, listing.userId)).some(
      (e) => e.gameName.toLowerCase() === listing.itemName.toLowerCase(),
    );
    const priceDisplay = listing.askingPrice != null ? formatPrice(listing.askingPrice) : 'the listed price';
    const dmBase = `⚡ <@${interaction.user.id}> (${buyerName}) just bought **${listing.itemName}** with Buy It Now for **${priceDisplay}**! Coordinate the exchange directly.`;
    if (inLibrary) {
      await seller.send({
        content: `${dmBase}\n\n**${listing.itemName}** is in your library. Would you like to remove it now that it's sold?`,
        components: [libraryRemoveRow(guildId, listing.id)],
      });
    } else {
      await seller.send(dmBase);
    }
  } catch { /* DMs disabled */ }

  for (const closedBid of result.closedBids) {
    try {
      const buyer = await interaction.client.users.fetch(closedBid.userId);
      await buyer.send(`Sorry, **${listing.itemName}** has been sold to someone else via Buy It Now. Thanks for your interest!`);
    } catch { /* DMs disabled */ }
    await lockBidDm(interaction.client, closedBid, '_🔒 Closed — this listing has been sold to someone else._');
  }

  await interaction.editReply({
    content: `✅ Purchase confirmed! **${listing.itemName}** is now marked as sold. Coordinate the exchange with the seller.`,
    components: [],
  });
}

// ── Modal: offer submitted ───────────────────────────────────────────────────

export async function handleBidModal(interaction: ModalSubmitInteraction, listingId: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const listing = await getListing(guildId, listingId);

  if (!listing || listing.status === 'sold' || listing.status === 'closed') {
    await interaction.editReply({ content: 'This listing is no longer available.' });
    return;
  }

  const amountRaw = (listing.type === 'sell' && listing.bidsAllowed)
    ? interaction.fields.getTextInputValue('bid_amount').trim()
    : '';
  const offerRaw = listing.type === 'trade'
    ? interaction.fields.getTextInputValue('bid_offer').trim()
    : '';
  const messageRaw = interaction.fields.getTextInputValue('bid_message').trim();

  let amount: number | undefined;
  if (amountRaw) {
    amount = parseFloat(amountRaw.replace(/[^0-9.]/g, ''));
    if (isNaN(amount)) {
      await interaction.editReply({ content: 'Invalid amount — please enter a number like `25.00`.' });
      return;
    }
  }

  const bidderName = interaction.member
    ? (interaction.member as { displayName?: string }).displayName ?? interaction.user.username
    : interaction.user.username;

  const result = await addBid(guildId, listingId, {
    userId: interaction.user.id,
    username: bidderName,
    amount,
    offer: offerRaw || undefined,
    message: messageRaw || undefined,
  });

  if (!result) {
    await interaction.editReply({ content: 'Could not submit offer.' });
    return;
  }

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'bid_placed',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
    bidId: result.bid.id,
    amount,
    offer: offerRaw || undefined,
  });

  const config = await getGuildConfig(guildId);
  const isFirm = isFirmListing(listing);

  const offerLines: string[] = [`**${bidderName}** is interested in **${listing.itemName}**`];
  if (amount != null) offerLines.push(`Offer: **${formatPrice(amount)}**`);
  if (offerRaw) offerLines.push(`Offering: **${offerRaw}**`);
  if (messageRaw) offerLines.push(`Message: ${messageRaw}`);

  const sellerNotification = offerLines.join('\n');

  if (config.marketplaceNegotiationMode === 'private') {
    // Private mode: negotiate via DMs. Seller gets action buttons; the listing post reflects updated status only.
    try {
      const seller = await interaction.client.users.fetch(listing.userId);
      const sentMsg = await seller.send({
        content: [
          `📬 **New offer on your ${listing.itemName} listing:**`,
          sellerNotification,
        ].join('\n'),
        components: [bidActionRow(listingId, result.bid.id, !isFirm)],
      });
      await updateBid(guildId, listingId, result.bid.id, { dmChannelId: sentMsg.channelId, dmMessageId: sentMsg.id });
    } catch {
      // seller DMs disabled — fall back to the listing post
    }
    try {
      await updateListingPost(result.listing, interaction.client, guildId);
    } catch (err) {
      console.error('[marketplace] private mode listing update failed:', err);
    }
  } else {
    // Public mode: post a text-only notification to the listing post, send action buttons via DM
    try {
      await postListingFollowup(listing, interaction.client, {
        content: `${sellerNotification}\n📬 <@${listing.userId}> — you have a new offer! Check your DMs from the bot to accept, deny, or counter.`,
      });
      await updateListingPost(result.listing, interaction.client, guildId);
    } catch (err) {
      console.error('[marketplace] public offer notification failed:', err);
    }

    let dmSent = false;
    try {
      const seller = await interaction.client.users.fetch(listing.userId);
      const sentMsg = await seller.send({
        content: [
          `📬 New offer on your **${listing.itemName}** listing:`,
          sellerNotification,
        ].join('\n'),
        components: [bidActionRow(listingId, result.bid.id, !isFirm)],
      });
      dmSent = true;
      await updateBid(guildId, listingId, result.bid.id, { dmChannelId: sentMsg.channelId, dmMessageId: sentMsg.id });
    } catch {
      // DMs disabled — post buttons to the listing post as fallback
    }

    if (!dmSent) {
      const fallback = await postListingFollowup(listing, interaction.client, {
        content: `<@${listing.userId}> — your DMs are disabled. Use the buttons below to respond:`,
        components: [bidActionRow(listingId, result.bid.id, !isFirm)],
      });
      if (fallback) {
        await updateBid(guildId, listingId, result.bid.id, { dmChannelId: fallback.channelId, dmMessageId: fallback.id });
      }
    }
  }

  if (config.marketplaceNegotiationMode !== 'private') {
    // DM already sent above with buttons; skip duplicate DM
  }

  const modeNote = config.marketplaceNegotiationMode === 'private'
    ? 'The seller has been notified via DM.'
    : 'Check the listing post for updates.';
  await interaction.editReply({ content: `Your interest has been sent to the seller. ${modeNote}` });
}

// ── No-BGG reference prompt handlers ────────────────────────────────────────

export async function handleAddRefButton(interaction: ButtonInteraction, draftId: string): Promise<void> {
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id) {
    await interaction.reply({ content: 'This session has expired. Please run the command again.', flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`mp_ref_modal_${draftId}`)
    .setTitle('Add a reference link')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('ref_link')
          .setLabel('Reference link (optional)')
          .setPlaceholder('https://...')
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleSkipRefButton(interaction: ButtonInteraction, draftId: string): Promise<void> {
  await interaction.deferUpdate();
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.' });
    return;
  }
  if (draft.listingType === 'sell') {
    await showPriceScreen(interaction, draft, draftId);
  } else {
    await createTradeListing(interaction, draft);
  }
}

export async function handleRefModal(interaction: ModalSubmitInteraction, draftId: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const draft = sellDrafts.get(draftId);
  if (!draft || draft.userId !== interaction.user.id) {
    await interaction.editReply({ content: 'This session has expired. Please run the command again.' });
    return;
  }

  const refLink = interaction.fields.getTextInputValue('ref_link').trim() || undefined;
  const updated = updateDraft(draftId, { referenceLink: refLink ?? draft.referenceLink })!;

  if (draft.listingType === 'sell') {
    await showPriceScreen(interaction, updated, draftId);
  } else {
    await createTradeListing(interaction, updated);
  }
}

// ── Library removal prompt (shown after a listing is sold) ──────────────────

function libraryRemoveRow(guildId: string, listingId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mp_lib_remove_${guildId}_${listingId}`)
      .setLabel('Yes, remove it')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`mp_lib_keep_${listingId}`)
      .setLabel('No, keep it')
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function handleLibraryRemove(
  interaction: ButtonInteraction,
  guildId: string,
  listingId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const listing = await getListing(guildId, listingId);
  if (!listing || listing.userId !== interaction.user.id) {
    await interaction.editReply({ content: 'Could not verify listing ownership.' });
    return;
  }
  const result = await removeGame(guildId, interaction.user.id, listing.itemName);
  await interaction.editReply({
    content: result === 'removed'
      ? `**${listing.itemName}** has been removed from your library.`
      : `**${listing.itemName}** was not found in your library.`,
  });
}

export async function handleLibraryKeep(interaction: ButtonInteraction): Promise<void> {
  await interaction.reply({ content: 'Got it — the item stays in your library.', flags: MessageFlags.Ephemeral });
}

// ── Button: Accept offer ─────────────────────────────────────────────────────

export async function handleAcceptBid(interaction: ButtonInteraction, listingId: string, bidId: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const found = await findListingById(listingId);
  if (!found) { await interaction.editReply({ content: 'Listing not found.' }); return; }
  const { guildId, listing } = found;
  const verb = listing.type === 'sell' ? 'sold' : 'traded';
  if (listing.userId !== interaction.user.id) { await interaction.editReply({ content: 'Only the seller can accept offers.' }); return; }

  const targetBid = listing.bids.find((b) => b.id === bidId);
  if (!targetBid) { await interaction.editReply({ content: 'Offer not found.' }); return; }
  if (targetBid.status !== 'open') {
    await interaction.editReply({ content: 'This offer is no longer open.' });
    try { await interaction.message.edit({ content: `${interaction.message.content}\n\n_This offer is no longer open._`, components: [] }); } catch { /* message may not be editable */ }
    return;
  }

  const result = await acceptBid(guildId, listingId, bidId);
  if (!result) { await interaction.editReply({ content: 'Offer not found.' }); return; }

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'bid_accepted',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
    bidId,
  });
  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'listing_sold',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
  });

  // Post visible conclusion before the listing post gets locked/finalized
  await postListingFollowup(result.listing, interaction.client, {
    content: `✅ **Deal done!** <@${listing.userId}> has accepted <@${result.acceptedBid.userId}>'s offer — **${listing.itemName}** is now ${verb}. Coordinate the exchange directly. This listing is now closed.`,
  });

  // Remove buttons from the DM/thread message that was clicked
  try {
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n✅ **Accepted** — deal done!`,
      components: [],
    });
  } catch { /* message may not be editable */ }

  await updateListingPost(result.listing, interaction.client, guildId);

  try {
    const buyer = await interaction.client.users.fetch(result.acceptedBid.userId);
    await buyer.send(
      `✅ Your offer on **${listing.itemName}** was accepted by ${listing.username}! Coordinate the exchange in the listing thread or message the seller directly.`,
    );
  } catch { /* DMs disabled */ }

  for (const closedBid of result.closedBids) {
    try {
      const buyer = await interaction.client.users.fetch(closedBid.userId);
      await buyer.send(`Sorry, **${listing.itemName}** has been ${verb} to someone else. Thanks for your interest!`);
    } catch { /* DMs disabled */ }
    await lockBidDm(interaction.client, closedBid, `_🔒 Closed — this listing has been ${verb} to someone else._`);
  }

  await interaction.editReply({ content: `Offer accepted! **${listing.itemName}** is now marked as ${verb}.` });

  const inLibrary = (await getGamesByUser(guildId, listing.userId)).some(
    (e) => e.gameName.toLowerCase() === listing.itemName.toLowerCase(),
  );
  if (inLibrary) {
    await interaction.followUp({
      content: `**${listing.itemName}** is in your library. Would you like to remove it now that it's ${verb}?`,
      components: [libraryRemoveRow(guildId, listingId)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ── Button: Deny offer ────────────────────────────────────────────────────────

export async function handleDenyBid(interaction: ButtonInteraction, listingId: string, bidId: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const found = await findListingById(listingId);
  if (!found) { await interaction.editReply({ content: 'Listing not found.' }); return; }
  const { guildId, listing } = found;

  const isSeller = listing.userId === interaction.user.id;
  const bid = listing.bids.find((b) => b.id === bidId);
  const isBuyer = bid?.userId === interaction.user.id;

  if (!isSeller && !isBuyer) {
    await interaction.editReply({ content: 'Only the seller or the other party can deny/withdraw this offer.' });
    return;
  }

  if (bid?.status !== 'open') {
    await interaction.editReply({ content: 'This offer is no longer open.' });
    try { await interaction.message.edit({ content: `${interaction.message.content}\n\n_This offer is no longer open._`, components: [] }); } catch { /* message may not be editable */ }
    return;
  }

  const result = await denyBid(guildId, listingId, bidId);
  if (!result) { await interaction.editReply({ content: 'Offer not found.' }); return; }

  const event = isBuyer ? 'bid_withdrawn' : 'bid_denied';
  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event,
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
    bidId,
  });

  // Remove buttons from the DM/thread message that was clicked
  try {
    const resultLabel = isBuyer ? '↩️ **Withdrawn** — offer withdrawn.' : '❌ **Declined** — offer denied.';
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n${resultLabel}`,
      components: [],
    });
  } catch { /* message may not be editable */ }

  await updateListingPost(result.listing, interaction.client, guildId);

  if (isSeller && bid) {
    try {
      const buyer = await interaction.client.users.fetch(bid.userId);
      await buyer.send(`Your offer on **${listing.itemName}** was declined. The listing is back to ${result.listing.status}.`);
    } catch { /* DMs disabled */ }
  }

  await interaction.editReply({ content: isBuyer ? 'Your offer has been withdrawn.' : 'Offer denied. The listing is back to active.' });
}

// ── Button: Counter offer ─────────────────────────────────────────────────────

export async function handleCounterButton(interaction: ButtonInteraction, listingId: string, bidId: string): Promise<void> {
  const found = await findListingById(listingId);
  if (!found) { await interaction.reply({ content: 'Listing not found.', flags: MessageFlags.Ephemeral }); return; }
  const { listing } = found;

  const bid = listing.bids.find((b) => b.id === bidId);
  const isSeller = listing.userId === interaction.user.id;
  const isBuyer = bid?.userId === interaction.user.id;

  if (!isSeller && !isBuyer) {
    await interaction.reply({ content: 'Only the seller or the other party can counter.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (bid?.status !== 'open') {
    await interaction.reply({ content: 'This offer is no longer open.', flags: MessageFlags.Ephemeral });
    try { await interaction.message.edit({ content: `${interaction.message.content}\n\n_This offer is no longer open._`, components: [] }); } catch { /* message may not be editable */ }
    return;
  }

  if (isFirmListing(listing)) {
    await interaction.reply({ content: "This is a firm-price listing — there's no price to counter.", flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`mp_counter_modal_${listingId}_${bidId}`)
    .setTitle(`Counter offer — ${listing.itemName}`.slice(0, 45));

  const components: ActionRowBuilder<TextInputBuilder>[] = [];

  if (listing.type === 'sell') {
    components.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('counter_amount')
          .setLabel('Your counter offer (USD)')
          .setPlaceholder('Enter amount, e.g. 30.00')
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
    );
  } else {
    components.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('counter_offer')
          .setLabel('Your counter offer')
          .setPlaceholder('Describe what you\'re offering')
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
    );
  }

  components.push(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('counter_message')
        .setLabel('Message (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500),
    ),
  );

  modal.addComponents(...components);
  await interaction.showModal(modal);

  // Strip the action buttons now that a counter is being composed.
  // showModal() responds to the interaction; message.edit() is a separate REST call.
  try {
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n💬 **Counter offer sent** — waiting for response.`,
      components: [],
    });
  } catch { /* message may not be editable */ }
}

// ── Modal: counter submitted ─────────────────────────────────────────────────

export async function handleCounterModal(
  interaction: ModalSubmitInteraction,
  listingId: string,
  bidId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const found = await findListingById(listingId);
  if (!found) { await interaction.editReply({ content: 'Listing not found.' }); return; }
  const { guildId, listing } = found;

  const bid = listing.bids.find((b) => b.id === bidId);
  if (!bid) { await interaction.editReply({ content: 'Offer not found.' }); return; }

  const isSeller = listing.userId === interaction.user.id;
  const isBuyer = bid.userId === interaction.user.id;
  if (!isSeller && !isBuyer) { await interaction.editReply({ content: 'You cannot counter this offer.' }); return; }

  if (bid.status !== 'open') {
    await interaction.editReply({ content: 'This offer is no longer open — your counter was not submitted.' });
    return;
  }

  if (isFirmListing(listing)) {
    await interaction.editReply({ content: "This is a firm-price listing — there's no price to counter." });
    return;
  }

  const amountRaw = listing.type === 'sell'
    ? interaction.fields.getTextInputValue('counter_amount').trim()
    : '';
  const offerRaw = listing.type !== 'sell'
    ? interaction.fields.getTextInputValue('counter_offer').trim()
    : '';
  const messageRaw = interaction.fields.getTextInputValue('counter_message').trim();

  let amount: number | undefined;
  if (amountRaw) {
    amount = parseFloat(amountRaw.replace(/[^0-9.]/g, ''));
    if (isNaN(amount)) { await interaction.editReply({ content: 'Invalid amount.' }); return; }
  }

  const fromName = interaction.member
    ? (interaction.member as { displayName?: string }).displayName ?? interaction.user.username
    : interaction.user.username;

  const result = await addCounter(guildId, listingId, bidId, {
    fromUserId: interaction.user.id,
    fromUsername: fromName,
    amount,
    offer: offerRaw || undefined,
    message: messageRaw || undefined,
  });

  if (!result) { await interaction.editReply({ content: 'Could not submit counter.' }); return; }

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'counter_made',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
    bidId,
    counterId: result.counter.id,
    amount,
    offer: offerRaw || undefined,
  });

  const counterLines: string[] = [`**Counter from ${fromName}** on **${listing.itemName}**`];
  if (amount != null) counterLines.push(`Counter offer: **${formatPrice(amount)}**`);
  if (offerRaw) counterLines.push(`Offering: **${offerRaw}**`);
  if (messageRaw) counterLines.push(messageRaw);

  const targetUserId = isSeller ? bid.userId : listing.userId;
  const responseRow = isSeller ? buyerResponseRow(listingId, bidId) : bidActionRow(listingId, bidId, !isFirmListing(listing));

  // Post text-only to the listing post; buttons go to the recipient via DM
  await postListingFollowup(listing, interaction.client, {
    content: `${counterLines.join('\n')}\n📬 <@${targetUserId}> — check your DMs from the bot to respond.`,
  });

  let dmSent = false;
  try {
    const target = await interaction.client.users.fetch(targetUserId);
    const sentMsg = await target.send({ content: counterLines.join('\n'), components: [responseRow] });
    dmSent = true;
    await updateBid(guildId, listingId, bidId, { dmChannelId: sentMsg.channelId, dmMessageId: sentMsg.id });
  } catch { /* DMs disabled */ }

  if (!dmSent) {
    const fallback = await postListingFollowup(listing, interaction.client, {
      content: `<@${targetUserId}> — your DMs are disabled. Use the buttons below to respond:`,
      components: [responseRow],
    });
    if (fallback) {
      await updateBid(guildId, listingId, bidId, { dmChannelId: fallback.channelId, dmMessageId: fallback.id });
    }
  }

  await interaction.editReply({ content: 'Counter submitted.' });
}

// ── Button: buyer accepts counter ────────────────────────────────────────────

export async function handleBuyerAcceptCounter(
  interaction: ButtonInteraction,
  listingId: string,
  bidId: string,
): Promise<void> {
  const found = await findListingById(listingId);
  if (!found) { await interaction.reply({ content: 'Listing not found.', flags: MessageFlags.Ephemeral }); return; }
  const { guildId, listing } = found;

  const verb = listing.type === 'sell' ? 'sold' : 'traded';
  const bid = listing.bids.find((b) => b.id === bidId);
  if (!bid || bid.userId !== interaction.user.id) {
    await interaction.reply({ content: 'You are not the other party on this offer.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (bid.status !== 'open') {
    await interaction.editReply({ content: 'This offer is no longer open.' });
    try { await interaction.message.edit({ content: `${interaction.message.content}\n\n_This offer is no longer open._`, components: [] }); } catch { /* message may not be editable */ }
    return;
  }

  const result = await acceptBid(guildId, listingId, bidId);
  if (!result) { await interaction.editReply({ content: 'Could not complete acceptance.' }); return; }

  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'bid_accepted',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
    bidId,
    details: 'buyer accepted counter',
  });
  await appendMarketplaceLog({
    timestamp: new Date().toISOString(),
    guildId,
    event: 'listing_sold',
    listingId,
    listingName: listing.itemName,
    listingType: listing.type,
    actorId: interaction.user.id,
    actorUsername: interaction.user.username,
  });

  // Post visible conclusion before the listing post gets locked/finalized
  await postListingFollowup(result.listing, interaction.client, {
    content: `✅ **Deal done!** <@${bid.userId}> accepted the counter offer from <@${listing.userId}> — **${listing.itemName}** is now ${verb}. Coordinate the exchange directly. This listing is now closed.`,
  });

  // Remove buttons from the DM message that was clicked
  try {
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n✅ **Accepted** — you accepted the counter offer!`,
      components: [],
    });
  } catch { /* message may not be editable */ }

  await updateListingPost(result.listing, interaction.client, guildId);

  try {
    const seller = await interaction.client.users.fetch(listing.userId);
    const inLibrary = (await getGamesByUser(guildId, listing.userId)).some(
      (e) => e.gameName.toLowerCase() === listing.itemName.toLowerCase(),
    );
    const dmBase = `✅ The other party accepted your counter on **${listing.itemName}**! Coordinate the exchange in the listing thread.`;
    if (inLibrary) {
      await seller.send({
        content: `${dmBase}\n\n**${listing.itemName}** is in your library. Would you like to remove it now that it's ${verb}?`,
        components: [libraryRemoveRow(guildId, listing.id)],
      });
    } else {
      await seller.send(dmBase);
    }
  } catch { /* DMs disabled */ }

  for (const closedBid of result.closedBids) {
    try {
      const buyer = await interaction.client.users.fetch(closedBid.userId);
      await buyer.send(`Sorry, **${listing.itemName}** has been ${verb} to someone else.`);
    } catch { /* DMs disabled */ }
    await lockBidDm(interaction.client, closedBid, `_🔒 Closed — this listing has been ${verb} to someone else._`);
  }

  await interaction.editReply({ content: `You accepted the counter — **${listing.itemName}** is now marked as ${verb}. Coordinate the exchange with the seller!` });
}
