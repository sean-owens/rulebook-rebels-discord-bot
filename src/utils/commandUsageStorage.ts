import { ApplicationCommandOptionType, ChatInputCommandInteraction, CommandInteractionOption } from 'discord.js';
import { readJson, writeJson } from './db';

const FILE = 'commandUsage.json';

// Per-guild counts of which slash commands get used and which optional
// parameters callers supply — never the parameter values themselves. Purged
// on guild deletion alongside the rest of a guild's data (see
// src/utils/guildLifecycle.ts's ARRAY_FILES).
export interface CommandUsageEntry {
  guildId: string;
  commandPath: string;
  totalCalls: number;
  paramCounts: Record<string, number>;
  lastUsedAt: string;
}

// Walks past subcommand-group/subcommand option nodes (which just describe
// routing, e.g. "admin event config") to the leaf-level options a caller
// actually filled in, so paramCounts only reflects real arguments.
export function extractCommandUsage(interaction: ChatInputCommandInteraction): {
  commandPath: string;
  paramNames: string[];
} {
  const pathParts = [interaction.commandName];
  let options: readonly CommandInteractionOption[] = interaction.options.data;
  while (
    options.length > 0 &&
    (options[0].type === ApplicationCommandOptionType.Subcommand ||
      options[0].type === ApplicationCommandOptionType.SubcommandGroup)
  ) {
    pathParts.push(options[0].name);
    options = options[0].options ?? [];
  }
  return { commandPath: pathParts.join(' '), paramNames: options.map((o) => o.name) };
}

async function loadAllCommandUsage(): Promise<CommandUsageEntry[]> {
  return readJson<CommandUsageEntry[]>(FILE, []);
}

export async function loadCommandUsage(guildId: string): Promise<CommandUsageEntry[]> {
  return (await loadAllCommandUsage()).filter((e) => e.guildId === guildId);
}

export async function recordCommandUsage(
  guildId: string,
  commandPath: string,
  paramNames: string[],
): Promise<void> {
  const all = await loadAllCommandUsage();
  let entry = all.find((e) => e.guildId === guildId && e.commandPath === commandPath);
  if (!entry) {
    entry = { guildId, commandPath, totalCalls: 0, paramCounts: {}, lastUsedAt: '' };
    all.push(entry);
  }
  entry.totalCalls += 1;
  entry.lastUsedAt = new Date().toISOString();
  for (const name of paramNames) {
    entry.paramCounts[name] = (entry.paramCounts[name] ?? 0) + 1;
  }
  await writeJson(FILE, all);
}
