import { EmbedBuilder, GuildMember, TextChannel } from 'discord.js';
import { getGuildConfig } from '../utils/config';

export async function handleGuildMemberAdd(member: GuildMember): Promise<void> {
  const config = await getGuildConfig(member.guild.id);

  // ── Welcome embed in introductions channel ───────────────────────────────
  if (config.welcomeChannelId) {
    try {
      const channel = (await member.client.channels.fetch(config.welcomeChannelId)) as TextChannel;

      const fields = [];

      if (config.rulesChannelId) {
        fields.push({
          name: '📋 Server Rules',
          value: `Head over to <#${config.rulesChannelId}> to get familiar with our community guidelines before diving in.`,
        });
      }

      fields.push({
        name: '🎮 Game Nights',
        value: `Check out <#${config.announcementsChannelId || 'announcements'}> for upcoming game nights. Click **Going** or **Maybe** on any event post to RSVP — you'll automatically get access to that event's private channel!`,
      });

      fields.push({
        name: '🎭 Game Preferences',
        value: `Use \`/myroles\` to set your preferred complexity level and tag the game genres you enjoy most!`,
      });

      if (config.facebookGroupUrl) {
        fields.push({
          name: '📘 Facebook Group',
          value: `Stay connected and up to date in our [Facebook Group](${config.facebookGroupUrl}).`,
        });
      }

      if (config.bggGroupUrl) {
        fields.push({
          name: '🎲 BoardGameGeek',
          value: `Check out our [BGG Group](${config.bggGroupUrl}) to see the games we're playing and connect with other members.`,
        });
      }

      fields.push({
        name: '👋 Introduce Yourself',
        value: `Tell us a bit about yourself right here! We'd love to know how you heard about the group and what games you enjoy.`,
      });

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`Welcome to Rulebook Rebels!`)
        .setDescription(
          `Hey ${member}! We're so glad you're here. Here are a few things to help you get started:`,
        )
        .addFields(fields)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: `Member #${member.guild.memberCount}` });

      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn('Could not post welcome message:', err);
    }
  }

  // ── DM to new member ─────────────────────────────────────────────────────
  try {
    await member.send(
      [
        `👋 Hey **${member.displayName}**, welcome to **${member.guild.name}**!`,
        ``,
        `One quick tip: consider setting a **server nickname** so the group knows who you are!`,
        ``,
        `Here's how:`,
        `> • **Desktop:** Right-click your name in the member list → *Edit Server Profile* → set a *Server Nickname*`,
        `> • **Mobile:** Tap your avatar → *Edit Server Profile* → set a *Server Nickname*`,
        ``,
        `See you at the table! 🎲`,
      ].join('\n'),
    );
  } catch {
    // User may have DMs disabled — that's fine
  }
}
