import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { GameNight } from './storage';

export function buildGameNightEmbed(gn: GameNight, nameMap: Record<string, string>): EmbedBuilder {
  const getName = (id: string) => nameMap[id] ?? `<@${id}>`;

  const yesNames = gn.rsvps.yes.map(getName);
  const maybeNames = gn.rsvps.maybe.map(getName);
  const noNames = gn.rsvps.no.map(getName);

  // Discord timestamp markup (<t:UNIX:STYLE>) auto-localizes per viewer, the
  // same way the native scheduled event does — unlike gn.date/gn.time, which
  // are frozen strings formatted once in whatever timezone was configured at
  // creation time.
  const startUnix = Math.floor(new Date(gn.startTimeISO).getTime() / 1000);
  const endUnix = gn.endTimeISO ? Math.floor(new Date(gn.endTimeISO).getTime() / 1000) : null;

  const embed = new EmbedBuilder()
    .setTitle(`${gn.title ?? 'Game Night'} — ${gn.date}`)
    .setColor(gn.cancelled ? 0x808080 : 0x5865f2)
    .addFields(
      { name: 'Date', value: `<t:${startUnix}:D>`, inline: true },
      {
        name: 'Time',
        value: endUnix ? `<t:${startUnix}:t> – <t:${endUnix}:t>` : `<t:${startUnix}:t>`,
        inline: true,
      },
      { name: 'Location', value: gn.location || 'TBD', inline: true },
    );

  if (gn.link) {
    embed.addFields({ name: 'Link', value: gn.link });
  }

  if (gn.description) {
    embed.addFields({ name: 'Description', value: gn.description });
  }

  if (gn.eventChannelId) {
    embed.addFields({ name: 'Channel', value: `<#${gn.eventChannelId}>` });
  }

  embed.addFields(
    {
      name: `Going (${gn.rsvps.yes.length})`,
      value: yesNames.length ? yesNames.join('\n') : '*No one yet*',
      inline: true,
    },
    {
      name: `Maybe (${gn.rsvps.maybe.length})`,
      value: maybeNames.length ? maybeNames.join('\n') : '*No one yet*',
      inline: true,
    },
    {
      name: `Can't Go (${gn.rsvps.no.length})`,
      value: noNames.length ? noNames.join('\n') : '*No one yet*',
      inline: true,
    },
  );

  if (gn.cancelled) {
    embed.setFooter({ text: 'This event has been cancelled.' });
  } else {
    embed.setFooter({ text: `Event ID: ${gn.id}` });
  }

  return embed;
}

const FORUM_PREVIEW_DESCRIPTION_CHARS = 300;

// Forum post cards only preview a message's text and attachments — never a bot's
// embed — so a post whose text is just "@everyone" shows up as a huge empty card
// (#112). This is the human-readable summary that goes under the ping so the card
// has real content. It mirrors the embed's date/location/description, and the
// embed stays the source of truth for RSVPs.
//
// Location and description are host-typed free text, and in message *content* (unlike
// an embed field) a stray "@everyone" or "<@&role>" would really ping. Mentions are
// defused with a zero-width space, and callers also pass allowedMentions limited to
// the one deliberate leading @everyone (see FORUM_POST_ALLOWED_MENTIONS).
function defuseMentions(text: string): string {
  return text.replace(/@/g, '@​').replace(/<(@[!&]?|#)(\d+)>/g, '<​$1$2>');
}

export const FORUM_POST_ALLOWED_MENTIONS = { parse: ['everyone' as const] };

export function buildForumPostContent(gn: GameNight): string {
  const startUnix = Math.floor(new Date(gn.startTimeISO).getTime() / 1000);
  const endUnix = gn.endTimeISO ? Math.floor(new Date(gn.endTimeISO).getTime() / 1000) : null;

  const when = endUnix ? `<t:${startUnix}:F> – <t:${endUnix}:t>` : `<t:${startUnix}:F>`;
  const lines = ['@everyone', `📅 ${when}`, `📍 ${defuseMentions(gn.location || 'TBD')}`];

  const description = gn.description?.trim();
  if (description) {
    const short =
      description.length > FORUM_PREVIEW_DESCRIPTION_CHARS
        ? `${description.slice(0, FORUM_PREVIEW_DESCRIPTION_CHARS - 1).trimEnd()}…`
        : description;
    lines.push(defuseMentions(short));
  }

  return lines.join('\n');
}

export function buildGameNightButtons(
  gnId: string,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rsvp_yes_${gnId}`)
      .setLabel('Going')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`rsvp_maybe_${gnId}`)
      .setLabel('Maybe')
      .setEmoji('❓')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`rsvp_no_${gnId}`)
      .setLabel("Can't Go")
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}
