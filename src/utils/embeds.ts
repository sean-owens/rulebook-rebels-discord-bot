import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { GameNight } from './storage';

export function buildGameNightEmbed(gn: GameNight, nameMap: Record<string, string>): EmbedBuilder {
  const getName = (id: string) => nameMap[id] ?? `<@${id}>`;

  const yesNames = gn.rsvps.yes.map(getName);
  const maybeNames = gn.rsvps.maybe.map(getName);
  const noNames = gn.rsvps.no.map(getName);

  const embed = new EmbedBuilder()
    .setTitle(`${gn.title ?? 'Game Night'} — ${gn.date}`)
    .setColor(gn.cancelled ? 0x808080 : 0x5865f2)
    .addFields(
      { name: 'Date', value: gn.date, inline: true },
      { name: 'Time', value: gn.time, inline: true },
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
