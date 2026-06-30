# Rulebook Rebels Discord Bot

A Discord bot for the Rulebook Rebels board game group. Manages game nights, a shared game library, event RSVPs, game suggestions, and member preferences across one or more Discord servers.

---

## Setup

### Prerequisites
- Node.js 18+
- A Discord application and bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- A BoardGameGeek API account (optional, for BGG integration)

### Install
```
npm install
```

### Environment variables
Create a `.env` file in the project root:
```
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_guild_id   # optional: scopes command deployment to one server (faster for dev)
```

### Deploy slash commands
```
npm run deploy
```

### Run
```
npx ts-node src/index.ts > bot.log 2>&1
```

---

## Inviting the Bot

Use the invite link in the `discord link` file at the repo root. When generating a new link via the Discord Developer Portal (OAuth2 → URL Generator), the required bot permissions are:

| Permission | Reason |
|---|---|
| View Channels | See channels to post in |
| Manage Channels | Create event channels, set RSVP access, move to archive |
| Manage Roles | Create Admin/Host roles on join, assign genre roles via `/myroles` |
| Manage Guild | Required to create roles that carry ManageGuild permission (Admin role) |
| Manage Events | Create Discord Scheduled Events; required to create roles with ManageEvents (Host role) |
| Send Messages | Post game cards, RSVP embeds, announcements |
| Embed Links | Send rich embeds |
| Attach Files | Send the "Powered by BGG" logo attachment |
| Read Message History | Update and edit existing embeds |
| Manage Messages | Pin request messages, delete game cards |
| Manage Threads | Archive marketplace forum threads when a listing is closed |
| Mention @everyone and Roles | Mention roles in game request announcements |

---

## Commands

| Command | Who can use it | What it does |
|---|---|---|
| `/event list` | Everyone | List upcoming game nights |
| `/game suggest` | Everyone | Suggest a game for an event |
| `/game list` | Everyone | See the game lineup for an event |
| `/game cancel` | Everyone | Remove your own game suggestion |
| `/library` | Everyone | Manage your game library, requests, and imports |
| `/myroles` | Everyone | Set your game genre preferences |
| `/bgg` | Everyone | Link/unlink your BoardGameGeek account |
| `/help` | Everyone | Show available commands (filtered by your role) |
| `/host event` | Host+ | Create, cancel, and archive game nights |
| `/host game cancel` | Host+ | Remove any game from the lineup |
| `/host library unrequest` | Host+ | Remove any game request from an event |
| `/admin event config` | Admin | Set server-wide event defaults |
| `/admin library` | Admin | Clear a member's library or re-sync BGG data |
| `/admin tags` | Admin | Add, remove, list, sync, and clear game tags |
| `/admin welcome` | Admin | Configure and test the welcome message |

---

## Server Roles

When the bot joins a server it automatically creates two roles:

- **Admin** (red) — full access to `/admin` and `/host` commands. Has Manage Guild, Manage Events, Manage Roles, Manage Messages, and Manage Channels.
- **Host** (blue) — access to `/host` commands. Has Manage Events and Manage Messages.

Assign these roles to the appropriate members. The bot's permission-gating is based on Discord native permissions, so any role or user with the equivalent Discord permissions will also gain access even without these specific roles.

---

## Data & Storage

All data is stored as JSON files in the `data/` directory (gitignored). Each file is guild-scoped so the bot can safely serve multiple servers from one process.

| File | Contents |
|---|---|
| `gamenights.json` | Game night records |
| `library.json` | Member game library entries |
| `library_requests.json` | Game requests per event |
| `games.json` | In-event game suggestions |
| `config.json` | Per-guild configuration |
| `bgg_accounts.json` | Linked BGG accounts per guild |
| `gameroles.json` | Game tag roles per guild |
| `user_collections.json` | BGG collection data per guild |
| `game_info.json` | Shared BGG game metadata cache (not guild-scoped) |
| `deleted_guilds.json` | Guilds pending the 30-day data retention window |

---

## Guild Data Lifecycle

When the bot is removed from a server, data is **not deleted immediately**. A 30-day retention window allows accidental removals to be reversed without any data loss.

### Step-by-step

| Step | Trigger | What happens | Log line |
|---|---|---|---|
| 1 | Bot removed from server | Guild is marked pending deletion in `deleted_guilds.json` | `[GuildDelete] Bot removed from "X" — data marked for deletion in 30 days` |
| 2a | Bot re-added **within 30 days** | Deletion marker is cleared, all data is intact | `[GuildCreate] Bot re-added to "X" — data restored (was pending deletion)` |
| 2b | Bot re-added as a **fresh join** | No restoration needed — roles created as normal | `[GuildCreate] Created "Admin" role in X` |
| 3 | 30-day window expires | All guild data is permanently purged on the next cleanup run | `[GuildLifecycle] Purged all data for guild <id>` |

The cleanup job runs once on bot startup and then every 24 hours.

### What gets purged

Everything scoped to that guild: game nights, library entries, requests, game suggestions, config, BGG accounts, game tag roles, and user collections. `game_info.json` is **not** purged as it is a shared cache across all guilds.

### Implementation files
- `src/events/guildDelete.ts` — marks guild deleted on removal
- `src/events/guildCreate.ts` — restores data if bot rejoins within retention window
- `src/utils/guildLifecycle.ts` — core logic: `markGuildDeleted`, `restoreGuild`, `purgeGuildData`, `runRetentionCleanup`
- `tests/guildLifecycle.test.ts` — unit tests for all lifecycle paths

---

## Development

```
npm run build      # compile TypeScript
npx vitest run     # run the test suite (must be fully green)
npm run deploy     # re-register slash commands (required when command definitions change)
```

See `CLAUDE.md` for full contributor guidelines and `TESTING.md` for the manual test checklist.
