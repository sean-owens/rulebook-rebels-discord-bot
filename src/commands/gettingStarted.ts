import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getGuildConfig } from '../utils/config';

export const data = new SlashCommandBuilder()
  .setName('getting-started')
  .setDescription('A quick walkthrough for new members');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const config = await getGuildConfig(interaction.guildId!);

  const steps: string[] = [];

  if (config.rulesChannelId) {
    steps.push(`**1. Read the rules** — check out <#${config.rulesChannelId}> before diving in.`);
  }

  steps.push(
    `**${steps.length + 1}. RSVP to a game night** — find upcoming events in ${
      config.announcementsChannelId ? `<#${config.announcementsChannelId}>` : 'the announcements channel'
    } and click **Going** or **Maybe** to get access to that event's channel.`,
  );
  steps.push(
    `**${steps.length + 1}. Set your preferences** — run \`/myroles\` to tag the genres you like and your preferred complexity.`,
  );
  steps.push(
    `**${steps.length + 1}. Suggest a game** — inside an event's channel, run \`/game suggest\` to put a game up for that night, or just tap the **🎲 Suggest a Game** button on the pinned "Quick Actions" message if you'd rather not type a command.`,
  );
  steps.push(
    `**${steps.length + 1}. Browse the library** — run \`/library list\` to see what games the group already owns. When you're ready to add your own games, \`/library add\` is there for you.`,
  );

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('👋 Getting Started')
    .setDescription(steps.join('\n\n'))
    .setFooter({
      text: 'Run /help any time to see everything else the bot can do — or ask a host or moderator if you get stuck.',
    });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
