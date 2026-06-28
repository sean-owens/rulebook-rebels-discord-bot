# Rulebook Rebels Discord Bot — Developer Guidelines

## 0. Collaboration Principles

**Challenge design decisions.** The goal is a great product, not agreement. If a proposed approach has real tradeoffs, risks, or better alternatives, say so directly before implementing. Pushback is a valid and expected response — accepting everything uncritically skews the design. Present the concern clearly, explain why it matters, and offer a recommendation. Then let the user decide.

---

## 1. Quality Standards

### 1a. Testing
Every feature, bug fix, or enhancement must keep the test suite accurate and current.

- **New logic → new tests.** Any function with conditional branches, data transformations, or error paths needs unit tests covering each case.
- **Bug fixes → update existing tests.** If a bug fix changes the correct output of an existing behaviour, update the test to match the new correct result rather than leaving a passing test that validates the old broken behaviour.
- **Test files live in `tests/`.** The suite runs with `npx vitest run`. All PRs/changes must leave the suite fully green.
- **Test the contract, not the implementation.** Tests should assert on observable outputs (return values, stored data) not internal implementation details.

### 1b. Documentation
Two documentation surfaces must stay in sync with every change:

- **`TESTING.md`** — Manual test checklist for Discord-facing behaviour. Update the relevant section(s) any time a command's inputs, outputs, or error conditions change. New commands get a new section.
- **In-bot help (`/help` command and any ephemeral guidance text)** — Command descriptions, parameter hints, and footer text visible to users must accurately describe current behaviour. If a command's purpose or usage changes, update `src/commands/help.ts` and any inline guidance strings.

Neither surface should describe behaviour that no longer exists, and neither should be missing behaviour that does.

### 1c. Production-Level Code

All code written for this system is treated as production code.

**New features:**
- Design for extensibility from the start. Consider how the feature will be versioned, extended, or configured differently per server before writing the first line.
- Prefer explicit, well-named interfaces and storage functions over one-off inline logic. Future contributors (and future Claude sessions) should be able to understand and build on the code without reading the entire codebase.
- Side effects (Discord API calls, file writes) should be isolated in clearly named functions so they can be tested, replaced, or extended independently.

**Bug fixes:**
- Treat existing command signatures and response formats as a public API. Users may have muscle memory or documentation referencing current parameter names and output shapes — avoid breaking changes unless there is a compelling reason.
- If a breaking change is unavoidable, note it explicitly in the commit message and update both `TESTING.md` and `/help` accordingly.
- Fix the root cause. Do not paper over symptoms with try/catch suppression or conditional guards that hide the real issue.

---

## 2. Multi-Server Architecture

This bot is designed to run across **multiple Discord servers**, each with potentially different configurations, channel layouts, and use cases. No behaviour should be hardcoded to a single server's setup.

### Principles
- **No hardcoded server IDs, channel IDs, role IDs, or category names.** Any value that differs between servers must come from configuration or be dynamically resolved at runtime.
- **Guild-scoped data.** All persistent data (game nights, library entries, requests) is already scoped to a guild via `guildId`. Maintain this pattern for all new storage.
- **Server-configurable behaviour.** Features that require a specific channel, category, or role (e.g. announcements channel, archive category, admin role) must be either:
  - Resolvable through Discord's native permission/channel structure (preferred), or
  - Stored in a per-guild config record that admins can set via a bot command (e.g. `/event config`).
- **Environment variables** are for secrets and deployment-level constants only (bot token, application ID, guild ID for command deployment). They are not a substitute for per-guild configuration.
- **Graceful degradation.** If an optional server-side resource (a category, a pinned message, a scheduled event) is missing or has been deleted, the bot should handle it gracefully and log a clear reason rather than crashing or silently failing.

### Adding server-configurable settings
When a new feature requires server-specific configuration:
1. Add the setting to the `GuildConfig` interface in `src/utils/storage.ts` (or equivalent config store).
2. Expose a way for admins to set it via an existing config command (e.g. `/event config`) or a new one if the scope warrants it.
3. Document the setting in `TESTING.md` under the relevant command section.
4. Default to a sensible no-op or fallback if the setting has not been configured.

---

## 3. Manual Testing

All Discord-facing behaviour must be manually verifiable. `TESTING.md` is the authoritative manual test checklist and must be kept current at all times.

### What belongs in TESTING.md
- Every command and subcommand, with a section per command.
- For each command: what it does (one-sentence description), the specific steps to exercise the happy path, and explicit steps for each known error/edge case.
- Any permission boundary (admin-only vs. regular user) must have a test case for both sides.
- When a bug is fixed, add or update a test case that would have caught it, so the same regression is detectable in future manual rounds.

### Format
Each section follows this pattern:
```
### <section number>. `/<command>`

**What it does:** <one-sentence description of current behaviour>

- [ ] <step that exercises the happy path>
- [ ] <step that exercises an error or edge case>
```

Checkboxes are left unchecked — they are meant to be ticked off during each manual test round, then reset for the next round.

### When to update TESTING.md
Update the relevant section(s) **in the same change** as the code — not after. If the section doesn't exist yet, add it. If a parameter, response message, or flow changes, update the description and steps to match exactly what the bot now does.

---

## 4. BGG API Rules

All code that touches the BoardGameGeek API must follow these rules, which come directly from BGG's terms of use.

### Request discipline
- **All BGG API requests must be made server-side** (i.e. from the bot process). Never make BGG requests from a client or browser context.
- **Cache results wherever practical.** Repeated lookups for the same game or user data should be served from local storage rather than hitting the API again. The BGG backup data in `BGG/backup-data/` exists for this reason.
- **Keep request volume to a minimum.** Batch or debounce where possible; never poll BGG in a loop without a strong reason.
- **Monitor usage** at `https://boardgamegeek.com/applications` → "Usage" to stay within license limits.

### Powered by BGG attribution
Because this bot is public-facing, BGG legal **requires** that all Discord embeds or responses that display BGG data include a "Powered by BGG" logo or attribution that links back to `https://boardgamegeek.com`. This is a legal requirement, not a suggestion — do not ship BGG-data-bearing embeds without it.

The logo lives at `BGG/images/powered_by_BGG_01_SM.png`. Pattern for every BGG-data embed:
```ts
const attachment = new AttachmentBuilder('BGG/images/powered_by_BGG_01_SM.png');
embed.setImage('attachment://powered_by_BGG_01_SM.png');
// include attachment in the reply: { embeds: [embed], files: [attachment] }
```

---

## 5. Local Development Workflow

Every code change — no matter how small — must go through the full local cycle before being considered done:

```
npm run build      # compile TypeScript, surface any type errors
npx vitest run     # run the full test suite, all tests must pass
npm run deploy     # re-register slash commands with Discord (required if command definitions changed)
```

Then restart the bot and confirm the process started cleanly before considering the change done. Discord-side command validation is handled by the user.

### Rules
- **Never skip the build.** A passing test suite on uncompiled code is not sufficient — `tsc` catches type errors that Vitest does not.
- **Never skip the tests.** Even a one-line change can break an existing test. The suite must be fully green before moving on.
- **Re-deploy when command definitions change.** Any change to a command's name, subcommands, options, or option descriptions requires `npm run deploy` to take effect in Discord. When in doubt, re-deploy.
- **Always cycle the bot process on restart.** Before launching a new bot instance locally, check for any existing `ts-node src/index.ts` processes and kill them all first. Only then start a single fresh process. This prevents duplicate bot instances from competing over the same gateway connection.
- **Do not commit or merge to Git unless explicitly instructed.** Work stays local until the user gives the go-ahead. This applies to all branches.
- **Confirm the process is running after deploy.** After restarting the bot, verify the process started cleanly with no crash or startup error. Discord-side command validation is the user's responsibility.
- **Always start the bot with logging.** Use `npx ts-node src/index.ts > bot.log 2>&1` (or equivalent) so stdout and stderr are captured. When diagnosing issues, read `bot.log` — errors from interaction handlers appear there. Never start the bot in a mode where output is silently discarded.
