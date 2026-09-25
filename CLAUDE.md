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
- **Send an honest User-Agent (`BGG_USER_AGENT` in `src/utils/bgg.ts`); never spoof a browser.** BGG's Cloudflare bot protection flags a Node client claiming to be Chrome (TLS-fingerprint mismatch) and serves a 403 challenge page, while the same request with an honest User-Agent succeeds (issue #78). Don't work around a future 403 with browser headers, cookies copied from a browser, or a proxy — that evades BGG's protection and conflicts with their terms.
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

## 5. Deployment Workflow (Railway)

The bot runs on Railway — there is no local bot process anymore. Every code change, no matter how small, must go through this cycle before being considered done:

```
npm run build      # compile TypeScript, surface any type errors
npx vitest run     # run the full test suite, all tests must pass
npm run deploy     # re-register slash commands with Discord (required if command definitions changed)
```

### Rules
- **Never skip the build.** A passing test suite on uncompiled code is not sufficient — `tsc` catches type errors that Vitest does not.
- **Never skip the tests.** Even a one-line change can break an existing test. The suite must be fully green before moving on.
- **Re-deploy commands when command definitions change.** Any change to a command's name, subcommands, options, or option descriptions requires `npm run deploy` to take effect in Discord. This is separate from a Railway deploy — Railway does not run it automatically. When in doubt, re-deploy.
- **Do not commit or push to Git unless explicitly instructed.** Work stays local until the user gives the go-ahead. This matters more now, not less: pushing/merging to `main` auto-deploys to Railway's development environment, and pushing/merging to `production` auto-deploys to Railway's **production** environment (see §6) — neither is a purely local, reversible action anymore.
- **Verify via Railway logs, not a local process.** There's no local process to restart and no `bot.log` to tail. After a deploy (dev or production), check Railway logs to confirm the bot started cleanly with no crash — this is the direct replacement for the old local log check. Discord-side command validation is the user's responsibility.
- **Never mutate Railway environment/service config via the CLI.** Commands like `railway service source connect`/`disconnect` are **not** scoped per-environment the way their `--environment` flag implies — they edit the *service's* shared source config, and reconnecting a source triggers an immediate deploy. Changing this once already caused an unintended production deploy (see `[[project_railway_deploy]]` memory for the full incident). Read-only commands (`railway status`, `railway logs`, `railway environment config`) are safe; anything that *changes* environment/service settings should be done by the user in the Railway dashboard, where per-environment scoping actually works correctly.

### Verifying a deploy (how, concretely)

The Railway CLI is installed and this repo is linked to the `rulebook-rebels-discord-bot` project, defaulting to the **development** environment.

- `railway status` — check the linked service is Online and see the current deployment ID. Add `-e <environment-id>` to check a specific environment.
- `railway logs --lines 50` — snapshot of recent logs from development (add `-e production` to check the production environment instead).
- `railway logs --filter "@level:error"` — just errors, useful right after a deploy.
- `railway logs --since 10m` — logs from a specific window, e.g. right after triggering a deploy.

A Railway MCP server and a `use-railway` skill are also installed (via `railway setup agent`) — prefer those over raw CLI parsing once available in a session, since they give structured results instead of text output to parse. Both require a Claude Code restart to register after being installed or updated.

If `railway status`/`railway logs` ever report "No linked project found," re-link with `railway link -p 920c1a12-cf1c-427c-89f3-3bf81ba08339 -s 2397cef3-4f08-48bb-891c-be5e2abba9ee -e <environment-id>` (development: `6385d7ae-6560-4aa6-9f73-2324760b87b4`, production: `5217f7a9-e487-4b6f-ad4d-9084e0b29681`).

---

## 6. Git Branching Workflow

- **`main`** — integration branch. Railway's **development** environment auto-deploys on every push/merge here.
- **`production`** — release branch. Railway's **production** environment auto-deploys on every push/merge here. Only gets updated by deliberately merging `main` into it (or a hotfix branch) when the code on `main` is actually ready to ship to real users.
- **Everything else is a short-lived feature branch**, branched from `main`, merged back into `main` via PR. Never commit directly to `main` or `production`.

### CI
`.github/workflows/ci.yml` runs `npm run build` + `npx vitest run` on every push and PR targeting `main` or `production`. This is **not** enforced as a merge gate — this repo is private on a plan where GitHub's branch protection / rulesets require GitHub Pro (confirmed by testing both the classic protection API and the newer rulesets API — both return `403 Upgrade to GitHub Pro`). Until/unless that changes, "no direct pushes, PR + green CI before merging" is a **convention**, not a server-enforced rule — follow it deliberately, and don't skip the build/test cycle just because nothing will technically stop you.

### Promoting to production
1. Decide the version bump (patch/minor/major — see Versioning & Releases below), bump `package.json`'s `version` field on a short-lived branch off `main`, PR it in, and merge — like any other change to `main`. Do this before step 3, so the bump travels into `production` along with everything else.
2. Confirm `main` is otherwise in the state you want to ship (built, tested, and ideally already running fine on the dev environment for a bit).
3. Open a PR merging `main` into `production` (or cherry-pick a hotfix if `main` has unrelated in-flight work you don't want to ship yet).
4. Merging that PR **is** the production deploy — Railway picks it up automatically. There is no separate manual "promote" click anymore now that production tracks its own branch.
5. Verify with `railway status -e 5217f7a9-e487-4b6f-ad4d-9084e0b29681` and `railway logs -e 5217f7a9-e487-4b6f-ad4d-9084e0b29681 --deployment --lines 30` immediately after.
6. Once verified live, tag the commit and cut a GitHub Release — see Versioning & Releases below. Never tag/release a commit that hasn't been confirmed running on production yet.

### Versioning & Releases
Every production promotion gets a semantic version (`vMAJOR.MINOR.PATCH`) and a corresponding GitHub Release, so there's a durable, browsable record of what's actually live in production and when — distinct from `main`'s own history, which moves faster and includes dev-only staging that may not be ready to ship. `main` itself is never tagged, only `production`, at the point each promotion is verified live.

**Choosing the bump**, based on everything shipping in this promotion since the last one:
- **MAJOR** — a breaking change to an existing command's signature or output format (see 1c) that users would need to notice or adjust for. Expected to be rare.
- **MINOR** — a new feature, command, or option — anything adding user-facing capability without breaking existing behavior.
- **PATCH** — a bug fix, internal refactor, or doc-only change, with no new user-facing capability.

If a promotion mixes several changes, the bump is whichever category is highest (one breaking change makes it MAJOR even alongside ten bug fixes).

**Mechanics**, after step 5 above has confirmed the deploy is live:
```
git tag -a v1.2.0 -m "v1.2.0"
git push origin v1.2.0
gh release create v1.2.0 --target production --generate-notes
```
`--generate-notes` has GitHub auto-build the release notes from PRs merged since the previous tag — no changelog to hand-maintain. Use the version now in `production`'s `package.json` for the tag name (`v` + that version).
