# Rulebook Rebels Discord Bot

A Discord bot for the Rulebook Rebels board game group. It manages game night events and their RSVPs, a shared game library, game suggestions and lineup scheduling, a community marketplace, private rooms, a weekly "guess the board game" challenge, and member preferences — across one or more Discord servers.

Other docs: [`GUIDE.md`](GUIDE.md) (member-facing user guide), [`TESTING.md`](TESTING.md) (manual test checklist), [`CLAUDE.md`](CLAUDE.md) (contributor guidelines), [`BGG/README.md`](BGG/README.md) (BoardGameGeek API rules).

---

## Environments & deployment

The bot runs on [Railway](https://railway.app) — there is no long-running local process. One Railway project has two environments, each backed by its own Discord application and its own storage bucket:

| | Development | Production |
|---|---|---|
| Deploys from | `main` (automatically, on every push/merge) | `production` (automatically, on every push/merge) |
| Discord bot | `rulebook-rebel-dev` (its own application/client ID and token) | The production bot (its own application/client ID and token) |
| Storage | Its own S3 bucket | Its own S3 bucket |
| Purpose | Integration/testing on the dev server | Real users |

Because the two bots are separate Discord applications, a slash-command change has to be registered against each bot separately (see [Deploying slash commands](#deploying-slash-commands)).

### Branching

- **`main`** — integration branch. Everything is merged here via a pull request from a short-lived feature branch; merging deploys to development.
- **`production`** — release branch. Only updated by deliberately merging `main` into it (or a hotfix); merging deploys to production.
- Never commit directly to `main` or `production`.
- CI (`.github/workflows/ci.yml`) runs `npm run build` and `npx vitest run` on every push and PR to either branch. It is a convention rather than an enforced merge gate (this repo's plan can't require status checks), so wait for green before merging.

### Promoting to production

1. Decide the version bump (`MAJOR` breaking command change, `MINOR` new feature, `PATCH` fix/docs), bump `version` in `package.json` on a branch off `main`, and merge it.
2. Confirm `main` is in the state you want to ship — ideally already running fine on development.
3. Open a PR merging `main` into `production`. Merging it **is** the production deploy.
4. Check Railway (`railway status` / `railway logs` against the production environment) to confirm a clean start.
5. Tag and release: `git tag -a vX.Y.Z -m "vX.Y.Z"`, `git push origin vX.Y.Z`, `gh release create vX.Y.Z --target production --generate-notes`.

See [`CLAUDE.md`](CLAUDE.md) §5–6 for the complete workflow, including how to check logs and which Railway CLI commands are safe (read-only) versus risky (anything that changes environment/service configuration should be done in the Railway dashboard).

### Configuration per environment

Both environments set the same variable names; the values that differ are the Discord credentials and the storage bucket.

| Variable | Required | Differs per environment? | Purpose |
|---|---|---|---|
| `DISCORD_TOKEN` | Yes | Yes | Bot token for that environment's Discord application |
| `DISCORD_CLIENT_ID` | Yes | Yes | Application ID for that environment's Discord application |
| `AWS_S3_BUCKET_NAME` | Yes (Railway) | Yes | Bucket holding all persisted data (Railway wipes the local disk on every deploy) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Yes (Railway) | Credentials for the bucket | S3 access |
| `AWS_DEFAULT_REGION` / `AWS_ENDPOINT_URL` | Yes (Railway) | Same in both today | Region, and endpoint for S3-compatible providers (omit endpoint for real AWS S3) |
| `BGG_API_KEY` | Recommended | Shared today | Bearer token for BoardGameGeek's XML API |
| `SHORT_LINK_BASE_URL` | Optional | Should match that service's public domain | Base URL of the bot's own short-link redirect service, used to keep the BG Stats "Log in BG Stats" button under Discord's link length limit. Leave unset to disable |
| `BGG_DEBUG_LOGGING` | Optional | No | `true` logs every BGG request (URL, status, attempt, timing). Off by default — flip on only while diagnosing a BGG issue |
| `BGG_CATALOG_MAINTAINER_ID` | Optional | No | Discord user ID to DM a weekly reminder to check for a newer BGG catalog dump |
| `BGG_SESSION_COOKIE` | Optional | — | Temporary authenticated-BGG cookie; superseded by `BGG_API_KEY` |
| `DISCORD_GUILD_ID` | Local only | — | Scopes `npm run deploy` to one server (instant updates). Not needed on Railway |
| `PORT` | Set by Railway | — | Port for the short-link redirect server |

`.env.example` has the same list with inline comments.

### Deploying slash commands

Railway does **not** register slash commands on deploy. Whenever a command's name, subcommands, options, or option descriptions change, run:

```
npm run deploy
```

It registers the commands for whichever bot the local `.env` credentials belong to (to `DISCORD_GUILD_ID` if set, otherwise globally). Before running it, make sure `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` in `.env` all belong to the *same* bot — they can drift apart — and that it is the bot you mean to update. Do it once for the development bot after a change lands on `main`, and once for the production bot when that change is promoted. If commands look wrong even after a successful deploy, check for stale commands registered in the *other* scope (global vs. guild).

### Verifying a deploy

```
railway status                               # is the service Online?
railway logs --lines 50                      # recent logs (development)
railway logs --filter "@level:error"         # just errors
railway logs -e production --lines 50        # production instead
```

A healthy start logs the BGG catalog loading, the short-link server listening, and `Logged in as <bot name>`.

---

## Local development

### Prerequisites
- Node.js 20+ (CI uses 20)
- A Discord application and bot token ([Discord Developer Portal](https://discord.com/developers/applications)) — use a development bot, not the production one
- A BoardGameGeek API token (optional, for live BGG lookups)

### Install and configure
```
npm install
cp .env.example .env     # then fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
```

With no `AWS_S3_BUCKET_NAME` set, data is stored as JSON files under `data/` (git-ignored).

### Common commands
```
npm run build      # compile TypeScript (catches type errors the tests don't)
npx vitest run     # run the full test suite — must be fully green
npm run deploy     # register slash commands with Discord (see above)
npm run dev        # run the bot locally with ts-node (needs a dev bot in .env)
npm run lint       # eslint
```

Every change should go through build → tests → (deploy, if commands changed) before it's considered done. See [`CLAUDE.md`](CLAUDE.md) for the full contributor guidelines, and update [`TESTING.md`](TESTING.md) and the in-bot `/help` text alongside any user-visible change.

---

## Inviting the bot

Each Discord application has its own invite link; the development and production links are kept in the `discord link.md` file at the repo root, with the required-permissions reference. To regenerate one: Discord Developer Portal → your app → OAuth2 → URL Generator, scopes `bot` + `applications.commands`. The required bot permissions:

| Permission | Reason |
|---|---|
| View Channels | See channels to post in |
| Manage Channels | Create event channels, set RSVP access, move to archive |
| Manage Roles | Create Admin/Host roles on join, assign genre roles via `/myroles` |
| Manage Guild | Required to create roles that carry ManageGuild permission (Admin role) |
| Manage Events | Create Discord Scheduled Events; required to create roles with ManageEvents (Host role) |
| Send Messages | Post game cards, RSVP embeds, announcements |
| Embed Links | Send rich embeds |
| Attach Files | Send the "Powered by BGG" logo and CSV templates |
| Read Message History | Update and edit existing embeds |
| Manage Messages | Delete game cards |
| Pin Messages | Pin the Quick Actions, lineup, requests, snacks and leaderboard messages (a separate permission from Manage Messages) |
| Manage Threads | Archive marketplace forum threads when a listing is closed |
| Mention @everyone and Roles | Mention roles in game request announcements |

Changing the permissions in a link does not change a bot already in a server — re-open the link to re-authorize it (no need to kick the bot first).

### Server setup after inviting

1. Create the channels the bot will use: an introductions channel (text), an announcements channel (forum), and a marketplace channel (forum or text).
2. `/admin tags sync` to create the built-in genre and difficulty roles (members then pick theirs with `/myroles`).
3. `/admin welcome config` to set the welcome and rules channels.
4. Optionally configure the marketplace (`/admin marketplace config`), private-room category (`/admin room config`), general-chat hub (`/admin general config`), weekly challenge (`/admin challenge config`), and event defaults such as timezone (`/admin event config`).

---

## Commands

Permission column: **Admin** = Manage Server, **Host** = Manage Events (Admins also qualify). The bot gates by Discord permissions, not by role name.

| Command | Who | What it does |
|---|---|---|
| `/help`, `/getting-started` | Everyone | Command list (filtered by role) and a new-member walkthrough |
| `/hub` | Everyone | The channel's "Quick Actions" buttons, as an ephemeral reply |
| `/event list` | Everyone | List upcoming game night events |
| `/game suggest / list / cancel / bgstats` | Everyone | Suggest a game (you're asked how well you know it; others can volunteer to teach), see the lineup, remove your suggestion, log a play in BG Stats |
| `/library …` | Everyone | Your group game library: `list`, `mine`, `add`, `remove`, `edit`, `clear`, `view`, `random`, `search`, `request`, `bring`, `unrequest`, `link`/`unlink` (share a library with another member), `import bgg` / `import csv` |
| `/myroles` | Everyone | Set your genre and difficulty preferences |
| `/bgg link / unlink / profile` | Everyone | Link your BoardGameGeek account |
| `/marketplace …` | Everyone | Buy/sell/trade: `post sell`, `post trade`, `browse`, `my`, `close`, `reopen`, `edit`, `price`, `conditions`, `import` (bulk from a CSV), `template` (sample CSV) |
| `/room create / close / persist / invite / kick` | Everyone | Private channels for you and the people you invite |
| `/snacks add / list / remove` | Everyone | Track who is bringing which snack for an event or room |
| `/challenge leaderboard / status` | Everyone | The weekly board game challenge (guesses are plain messages in the challenge channel) |
| `/host event create / edit / cancel / archive / privacy / greeters` | Host | Manage game night events |
| `/host game cancel` | Host | Remove any game from a lineup |
| `/host library unrequest` | Host | Remove any game request from an event |
| `/host challenge points` | Host | Adjust a member's challenge points |
| `/admin event config / preview` | Admin | Server-wide event defaults; dry-run the lineup schedule |
| `/admin library clear / sync / syncall / backfilltop` | Admin | Library maintenance and BGG re-sync |
| `/admin tags add / remove / list / sync / clear` | Admin | Game genre tags and their roles |
| `/admin welcome config / test / greet` | Admin | The new-member welcome message |
| `/admin marketplace config / purge` | Admin | Marketplace channel and negotiation mode; cleanup |
| `/admin room config`, `/admin general config` | Admin | Private-room category; general-chat Quick Actions hub |
| `/admin challenge config / reset-scores` | Admin | Board game challenge schedule and leaderboard |
| `/admin usage`, `/admin bgstats` | Admin | Command usage stats; BG Stats link opens |

`/help` in Discord is the always-current list; this table is a summary.

---

## Server roles

When the bot joins a server it creates two roles:

- **Admin** (red) — full access to `/admin` and `/host`. Has Manage Guild, Manage Events, Manage Roles, Manage Messages, and Manage Channels.
- **Host** (blue) — access to `/host`. Has Manage Events and Manage Messages.

Any role or user with the equivalent Discord permissions gains the same access without these specific roles.

---

## Data & storage

All persisted data is JSON, and every record is scoped to a guild (`guildId`) so one process can safely serve many servers.

| File | Contents |
|---|---|
| `gamenights.json` | Event records |
| `games.json` | In-event game suggestions (seats, waitlists, teachers, guests) |
| `library.json` | Member game library entries |
| `library_requests.json` | "Bring this game" requests per event |
| `library_links.json` | Library sharing links between members |
| `game_info.json` | Shared BGG game metadata cache (not guild-scoped) |
| `bgg_accounts.json` | Linked BGG accounts |
| `user_collections.json` | Imported BGG collection data |
| `bgg_discovered_entries.json` | Games found via live BGG search and folded into the local catalog |
| `gameroles.json` | Genre/difficulty tag roles |
| `config.json` | Per-guild configuration |
| `marketplace.json` | Marketplace listings and bids |
| `marketplace-drafts.json` | In-progress marketplace listing flows (survive a redeploy) |
| `marketplace_log.jsonl` | Append-only marketplace activity log |
| `privateRooms.json` | Private rooms |
| `snacks.json` | Snack lists |
| `board_game_challenges.json`, `board_game_challenge_leaderboard.json` | Weekly challenges and the leaderboard |
| `shortlinks.json`, `shortlink-status-messages.json` | Short links for BG Stats buttons (bot-global) |
| `commandUsage.json` | Per-guild command usage counts |
| `deleted_guilds.json` | Guilds pending the 30-day retention window |
| `system_state.json` | Bot-global state (e.g. last BGG catalog reminder) |

### Storage backend

Locally these files live under `data/`. When `AWS_S3_BUCKET_NAME` is set (as on Railway, plus the other `AWS_*` variables), the bot reads and writes every file to that bucket instead. This is required in production: without it, all data is lost each time the service redeploys. `src/utils/db.ts` is the single module that chooses between disk and S3. Development and production use separate buckets, so their data never mixes.

### BoardGameGeek data

- A snapshot of BGG's ranked-games dump (`BGG/backup-data/boardgames_ranks_*.zip`) is loaded into memory at startup as a local catalog used for name matching and the challenge's game pool. Update it by replacing the zip, committing, and redeploying (set `BGG_CATALOG_MAINTAINER_ID` for a weekly reminder DM).
- Live BGG API calls are made server-side only, cached where possible, and kept to a minimum. Any embed showing BGG data must include the "Powered by BGG" logo (see [`BGG/README.md`](BGG/README.md) and `CLAUDE.md` §4).
- The bot identifies itself to BGG with an honest `RulebookRebelsBot/…` User-Agent. Do not change it to a browser-style one: BGG's Cloudflare bot protection compares the claimed User-Agent to the connection's TLS fingerprint, and a Node process claiming to be Chrome gets a 403 "Just a moment…" challenge page (this caused issue #78, which looked like an IP block but was not one — the same request from the same IP succeeds with an honest User-Agent). If live BGG calls start returning 403 again, check that header first.

---

## Guild data lifecycle

When the bot is removed from a server, data is **not deleted immediately** — a 30-day retention window lets an accidental removal be reversed with no data loss.

| Step | Trigger | What happens |
|---|---|---|
| 1 | Bot removed from server | Guild is marked pending deletion in `deleted_guilds.json` |
| 2a | Bot re-added within 30 days | Deletion marker is cleared; all data is intact |
| 2b | Bot re-added as a fresh join | Roles are created as normal |
| 3 | 30-day window expires | All guild data is permanently purged on the next cleanup run |

The cleanup job runs once on startup and then every 24 hours. It purges everything scoped to the guild (events, library, requests, suggestions, config, BGG accounts, tag roles, collections, and so on); shared caches such as `game_info.json` are kept. Implementation: `src/events/guildDelete.ts`, `src/events/guildCreate.ts`, `src/utils/guildLifecycle.ts`, tested in `tests/guildLifecycle.test.ts`.
