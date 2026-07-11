import { describe, it, expect, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { execute } from '../src/commands/help';

function makeInteraction(permissions: Set<bigint>) {
  return {
    memberPermissions: { has: (perm: bigint) => permissions.has(perm) },
    reply: vi.fn(async () => {}),
  } as any;
}

describe('/help', () => {
  it('replies successfully for a regular member (no admin/host fields)', async () => {
    const interaction = makeInteraction(new Set());
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields.some((f: any) => f.name.includes('/admin'))).toBe(false);
    expect(embed.fields.some((f: any) => f.name.includes('/host'))).toBe(false);
  });

  it('replies successfully for a host', async () => {
    const interaction = makeInteraction(new Set([PermissionFlagsBits.ManageEvents]));
    await execute(interaction);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields.some((f: any) => f.name.includes('/host'))).toBe(true);
    expect(embed.fields.some((f: any) => f.name.includes('/admin'))).toBe(false);
  });

  it('replies successfully for an admin, including the admin fields', async () => {
    const interaction = makeInteraction(new Set([PermissionFlagsBits.ManageGuild]));
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields.some((f: any) => f.name.includes('/admin'))).toBe(true);
    expect(embed.fields.some((f: any) => f.name.includes('/host'))).toBe(true);
  });

  // Regression test: an /admin field previously grew past Discord's 1024-char
  // field value limit, which made EmbedBuilder throw and silently broke
  // /help for every admin (no reply, no error visible to the user).
  it('keeps every embed field within Discord limits regardless of permission tier', async () => {
    const tiers = [
      new Set<bigint>(),
      new Set([PermissionFlagsBits.ManageEvents]),
      new Set([PermissionFlagsBits.ManageGuild]),
    ];
    for (const permissions of tiers) {
      const interaction = makeInteraction(permissions);
      await expect(execute(interaction)).resolves.not.toThrow();

      const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
      expect(embed.fields.length).toBeLessThanOrEqual(25);
      for (const field of embed.fields) {
        expect(field.name.length).toBeLessThanOrEqual(256);
        expect(field.value.length).toBeLessThanOrEqual(1024);
      }
    }
  });
});
