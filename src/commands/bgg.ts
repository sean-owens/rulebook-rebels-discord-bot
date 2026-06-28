import { AttachmentBuilder, ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { validateBggUser, getBggUserProfile } from '../utils/bgg';
import { getBggAccount, setBggAccount, removeBggAccount } from '../utils/bggAccountStorage';

const BGG_LOGO = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');

const LINK_COOLDOWN_MS = 30_000;
const linkCooldowns = new Map<string, number>();

export const data = new SlashCommandBuilder()
  .setName('bgg')
  .setDescription('Link your BoardGameGeek account')
  .addSubcommand(sub =>
    sub
      .setName('link')
      .setDescription('Link your BoardGameGeek account to this server')
      .addStringOption(opt =>
        opt.setName('username').setDescription('Your BoardGameGeek username').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('unlink').setDescription('Remove your linked BoardGameGeek account from this server')
  )
  .addSubcommand(sub =>
    sub.setName('profile').setDescription('View your linked BoardGameGeek account')
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'link') await handleLink(interaction);
  else if (sub === 'unlink') await handleUnlink(interaction);
  else if (sub === 'profile') await handleProfile(interaction);
}

async function handleLink(interaction: ChatInputCommandInteraction): Promise<void> {
  const username = interaction.options.getString('username', true).trim();
  const existing = getBggAccount(interaction.guildId!, interaction.user.id);

  if (existing && existing.bggUsername.toLowerCase() === username.toLowerCase()) {
    await interaction.reply({
      content: `Your BoardGameGeek account **[${existing.bggUsername}](https://boardgamegeek.com/user/${encodeURIComponent(existing.bggUsername)})** is already linked on this server.`,
      ephemeral: true,
    });
    return;
  }

  const cooldownKey = `${interaction.guildId}:${interaction.user.id}`;
  const lastAttempt = linkCooldowns.get(cooldownKey) ?? 0;
  const remaining = LINK_COOLDOWN_MS - (Date.now() - lastAttempt);
  if (remaining > 0) {
    await interaction.reply({
      content: `Please wait ${Math.ceil(remaining / 1000)} seconds before trying again.`,
      ephemeral: true,
    });
    return;
  }
  linkCooldowns.set(cooldownKey, Date.now());

  await interaction.deferReply({ ephemeral: true });

  let bggUser;
  try {
    bggUser = await validateBggUser(username);
  } catch (err) {
    console.error('[BGG link] validateBggUser failed:', err);
    bggUser = null;
  }

  if (!bggUser) {
    await interaction.editReply('We couldn\'t verify that BoardGameGeek account. Double-check your username and try again.');
    return;
  }

  setBggAccount(interaction.guildId!, interaction.user.id, bggUser.username);

  const isRelink = !!existing;
  const description = isRelink
    ? `Your BoardGameGeek account has been updated from **${existing.bggUsername}** to **[${bggUser.username}](https://boardgamegeek.com/user/${encodeURIComponent(bggUser.username)})**.`
    : `Your BoardGameGeek account **[${bggUser.username}](https://boardgamegeek.com/user/${encodeURIComponent(bggUser.username)})** has been linked to this server.`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(isRelink ? 'BoardGameGeek Account Updated' : 'BoardGameGeek Account Linked')
    .setDescription(description)
    .addFields({ name: 'What this unlocks', value: 'You can now import your BoardGameGeek collection and use BoardGameGeek-connected features on this server.' })
    .setImage('attachment://powered_by_BGG_01_SM.png');

  await interaction.editReply({ embeds: [embed], files: [BGG_LOGO] });
}

async function handleUnlink(interaction: ChatInputCommandInteraction): Promise<void> {
  const removed = removeBggAccount(interaction.guildId!, interaction.user.id);

  if (!removed) {
    await interaction.reply({ content: 'You don\'t have a BoardGameGeek account linked on this server.', ephemeral: true });
    return;
  }

  await interaction.reply({ content: 'Your BoardGameGeek account has been unlinked from this server.', ephemeral: true });
}

async function handleProfile(interaction: ChatInputCommandInteraction): Promise<void> {
  const account = getBggAccount(interaction.guildId!, interaction.user.id);

  if (!account) {
    await interaction.reply({
      content: 'You don\'t have a BoardGameGeek account linked on this server. Use `/bgg link` to connect one.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let profile;
  try {
    profile = await getBggUserProfile(account.bggUsername);
  } catch (err) {
    console.error('[BGG profile] getBggUserProfile failed:', err);
    profile = null;
  }

  const profileUrl = `https://boardgamegeek.com/user/${encodeURIComponent(account.bggUsername)}`;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Your BoardGameGeek Profile')
    .setDescription(`**[${account.bggUsername}](${profileUrl})**`);

  if (profile) {
    const fields: { name: string; value: string; inline?: boolean }[] = [];

    if (profile.memberSince) {
      fields.push({ name: 'Member Since', value: profile.memberSince, inline: true });
    }

    const baseStr = profile.baseGames !== null ? `${profile.baseGames} games` : null;
    const expStr = profile.expansions !== null ? `${profile.expansions} expansions` : null;
    const collectionValue = (baseStr || expStr)
      ? [baseStr, expStr].filter(Boolean).join('\n')
      : 'Unavailable — try again shortly';
    fields.push({ name: 'Collection', value: collectionValue, inline: true });

    if (profile.topGames.length > 0) {
      const topList = profile.topGames
        .map(g => `${g.rank}. ${g.name}`)
        .join('\n');
      fields.push({ name: 'Top Games', value: topList });
    }

    embed.addFields(...fields);
  } else {
    embed.addFields({ name: 'Profile data', value: 'Could not load BoardGameGeek profile data right now — try again in a moment.' });
  }

  embed.setImage('attachment://powered_by_BGG_01_SM.png');

  await interaction.editReply({ embeds: [embed], files: [BGG_LOGO] });
}
