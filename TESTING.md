# Rulebook Rebels Bot — Testing Guide

This document describes every feature in the bot and provides a checklist of test cases to verify correct behavior. All tests are performed in Discord using slash commands unless otherwise noted.

The guide has two top-level groups, so you know at a glance whether you can run a test alone or need to wait until a second person is around:

- **🧍 Single-Tester Tests** — every one of these can be completed solo by one person with the right role. Sub-grouped by permission tier (Member → Host → Admin), plus system/automated behavior and role-agnostic edge cases.
- **👥 Multi-Person Tests** — these genuinely cannot be completed alone, even with several test accounts on hand, because they involve live back-and-forth between two distinct Discord identities (marketplace DM negotiation) or a real join event (new member welcome). All of them live together in one place so you can knock them all out in a single sitting whenever a second tester is available. Also sub-grouped by which tier's flow needed the second person (Member-tier marketplace flows, then a System/Automated flow).

**A note on the numbering:** each test still carries its original **Part N** label (Part 1 = Member, Part 2 = Host, Part 3 = Admin, Part 4 = System & Automated, Part 5 = Multi-Person, Part 6 = General Edge Cases) — that numbering is also used throughout the doc for cross-references (e.g. `(2.8a)`, `(4.7)`, `5.1a`). Those numbers reflect *what* a test is, not the order it appears in — Part 5 (multi-person) is physically placed at the very end of the document, after Part 6, so all solo-testable parts (1–4, 6) come first and stay together.

Within **🧍 Single-Tester Tests**:
- **Part 1 — Regular Member Tests**: no elevated role required.
- **Part 2 — Host Tests**: requires the Host role (or Manage Events permission). Fully repeats Part 1 plus Host-only commands, since Hosts must retain full member-level access.
- **Part 3 — Admin Tests**: requires the Admin role (or Manage Guild permission). Fully repeats Parts 1 and 2 plus Admin-only commands, since Admins must retain full member- and Host-level access.
- **Part 4 — System & Automated Behavior**: features triggered by Discord events/timers rather than a slash command permission check (bot join/leave, scheduled event completion, new member join). Requires server ownership or Admin-level Discord permissions to exercise (adding/removing the bot, editing scheduled events), even though it isn't part of the slash-command tier model.
- **Part 6 — General Edge Cases**: role-agnostic sanity checks. Run once, regardless of which tier you're testing.

Because Parts 2 and 3 repeat the tests from the tier(s) below them, the same test case appears more than once in this document — that's intentional, not a copy/paste error. It lets a tester assigned to a single tier work from one self-contained part. Where a test case needed a second person instead, the original spot (in Parts 1–4) has a one-line pointer into **👥 Multi-Person Tests** rather than the checklist itself.

Within **👥 Multi-Person Tests**:
- **Part 5 — Multi-Person Tests**: pulled out of Parts 1–4 so they're not scattered through solo-testable checklists. Grouped first by tier (5.1 is a Member-tier flow — marketplace negotiation only ever needs two regular members, no elevated role on either side; 5.2 is a System/Automated flow — a new member joining), then by which pairing you need to recruit within that.

---

## Prerequisites

- At least one game tag must exist for `/myroles` to be testable — run `/admin tags sync` first.
- Three test accounts are recommended: one with no elevated role, one with the Host role, and one with the Admin role.
- At least one upcoming, non-cancelled event should exist before testing `/event`, `/game`, or the event-scoped `/library` commands (`request`, `unrequest`, `bring`) — create one first with `/host event create` (2.8a).
- A marketplace channel should be configured via `/admin marketplace config` (3.9m) before testing `/marketplace post sell`/`post trade` end-to-end — listings are still created without one (that's its own test case), but you won't see the resulting forum post.
- A BGG account should be linked via `/bgg link` before testing `/library import bgg`.
- **For Part 5:** you'll need a second, distinct Discord account you can act as concurrently with your primary tester account — reusing one of the three test accounts above is fine. Discord does not allow an account to DM itself, so marketplace negotiation genuinely cannot be exercised with only one identity. For the "new member joins" case, you don't need a never-before-seen account — kicking an existing test account from the server and re-inviting it fires the same join event the welcome flow listens for.
- 👑 marks a check that will behave differently — usually silently pass when it should fail — if run from the Discord **server owner's** account. This bot enforces its Host/Admin tiers entirely through Discord's native `Manage Events`/`Manage Server` permission bits (no custom role lookup), and Discord grants the server owner every permission implicitly and permanently, regardless of what role (if any) they're assigned. An owner account can never be used to validate a "this should be denied to non-hosts/non-admins" case — use a genuinely separate, non-owner account for anything marked 👑.

---

# 🧍 Single-Tester Tests

Everything in this group (Parts 1–4, 6) can be completed solo by one tester holding the appropriate role — no second Discord identity needed.

---

# Part 1 — Regular Member Tests (no elevated role required)

## 1.1 `/help`

**What it does:** Displays an ephemeral embed listing all available commands. Shows a Host section to members with Manage Events permission. Shows an Admin section to members with Manage Guild permission.

- [ ] 👑 Run `/help` as a regular member — confirm only user-facing command sections appear (`/event`, `/game`, `/library`, `/myroles`, `/bgg`, `/marketplace`, `/room`) with **no Host or Admin section**
- [ ] Confirm `/game cancel` description says "Remove your own game suggestion"
- [ ] Confirm `/library clear` description says "Remove all your own games at once"
- [ ] Confirm the `/library` field lists `random` and `search`, both noting they default to `/myroles` preferences
- [ ] Confirm the top description points new members to `/getting-started` for a shorter walkthrough
- [ ] Confirm the response is ephemeral
- [ ] 👑 Confirm `/host` and `/admin` commands are **not visible** in the Discord slash command picker

## 1.1a `/getting-started`

**What it does:** Displays a short, ephemeral, ordered walkthrough for new members — RSVPing to a game night, setting preferences (`/myroles`), suggesting a game (`/game suggest`), and browsing the library (`/library list`) — plus a rules-channel step if one is configured. Deliberately omits `/library add` from the numbered steps' emphasis and BGG linking, marketplace, and rooms entirely, so a brand-new member isn't asked to commit to anything on day one; it points to `/help` for the rest.

- [ ] Run `/getting-started` with no rules channel configured (`/admin welcome config`, 3.9j) — confirm the walkthrough starts at "RSVP to a game night" with no rules-channel step
- [ ] Configure a rules channel (3.9j), run `/getting-started` again — confirm "Read the rules" is now step 1 and links to that channel, and the remaining steps renumber accordingly
- [ ] Confirm the walkthrough mentions `/myroles`, `/game suggest`, and `/library list`
- [ ] Confirm the response is ephemeral

## 1.2 `/event` — Event Viewing

### 1.2a `/event list`

**What it does:** Lists all upcoming (non-cancelled, non-archived) game nights with IDs, dates, times, and RSVP counts.

- [ ] With at least one active event — confirm it shows the event with its ID and details
- [ ] With no active events — confirm it shows "No upcoming game nights scheduled"
- [ ] Confirm the response is ephemeral

### 1.2b RSVP Buttons

**What it does:** Members click Going / Maybe / Can't Go on the RSVP embed to update their RSVP status. In RSVP-only mode, Going/Maybe grants access to the event channel.

**Prerequisites:** an event must already exist with its RSVP embed posted (created via `/host event create`, 2.8a) — see the global Prerequisites section above.

- [ ] Click **Going** — confirm:
  - RSVP count updates in the embed
  - Member gains access to the event channel (if RSVP-only mode)
- [ ] Click **Maybe** — confirm similar behavior to Going
- [ ] Click **Can't Go** — confirm:
  - RSVP count updates
  - Member loses access to the event channel (if RSVP-only mode)
- [ ] Toggle between statuses (Going → Maybe → Can't Go → Going) — confirm counts stay accurate
- [ ] Remove "Interested" from the Discord scheduled event directly — confirm bot marks user as Can't Go

## 1.3 `/game` — Game Suggestions

All `/game` commands should be used inside an active event channel unless otherwise noted.

### 1.3a `/game suggest`

**What it does:** Suggests a game for the event (or, from inside a private room, for that room — see below). Checks the group library first (exact match → partial match → BGG search). Prompts to add tags if not already tagged.

#### From a private room
- [ ] Run `/game suggest title:Wingspan` from inside a `/room`-created private room channel (1.8a) — confirm it posts the game card directly in the room, with no event picker
- [ ] Suggest a library game whose owner is a member of the room but not attending any event — confirm it's allowed (attendance is checked against room membership, not event RSVPs)
- [ ] Suggest a library game whose owner is **not** a member of the room — confirm "None of the owners are attending" error, same wording as the event case
- [ ] Confirm Join/Leave buttons on a room-suggested game card work the same as in an event channel
- [ ] Confirm suggesting in a room does **not** create a request-pin or lineup-pin entry — "bring to a future event" tracking doesn't apply to an ad-hoc room

#### From a library game (exact match)
- [ ] Add a game to your library first (`/library add game:Wingspan`)
- [ ] RSVP Going to the event
- [ ] Run `/game suggest title:Wingspan` — confirm game card appears in the event channel with owner listed
- [ ] Confirm the suggester is automatically shown as a seated player on the game card
- [ ] Confirm the tag picker appears if the game has no tags set
- [ ] Try suggesting the same game again — confirm "already in the lineup" duplicate error

#### From a library game (partial match)
- [ ] Run `/game suggest title:Wing` (partial) — confirm a dropdown appears with library matches and a "Search BGG instead" option
- [ ] Select a match from the dropdown — confirm the game is added

#### Game owner not attending
- [ ] Attempt to suggest a game where the owner has not RSVP'd — confirm "None of the owners are attending" error

#### From BGG search
- [ ] Run `/game suggest title:Ticket to Ride` — confirm BGG results dropdown appears
- [ ] Confirm results are sorted newest publish year first
- [ ] Select a result — confirm game card is posted with BGG-sourced data
- [ ] If the BGG game has no tags — confirm tag picker appears
- [ ] Select tags, click Save — confirm tags appear on the game card and prompt to confirm bringing the game
- [ ] Click Skip on tag picker — confirm bring prompt appears
- [ ] Search a generic term with more than 24 BGG matches — confirm **← Previous** / **Page X of Y** / **Next →** buttons appear below the dropdown, with Previous disabled on page 1
- [ ] Click **Next →** — confirm the dropdown updates to the next page of results (newest-first order continues across pages) and **Previous** becomes enabled
- [ ] Navigate to the last page — confirm **Next →** is disabled
- [ ] Search a term with 24 or fewer matches — confirm no pagination buttons appear (dropdown only)

#### With expansions
- [ ] Run `/game suggest title:Wingspan with_expansions:True`
- [ ] Select the game from BGG results — confirm expansion selection dropdown appears
- [ ] Select expansions and confirm — confirm game card shows expansions
- [ ] If a game has no expansions — confirm it posts directly without the expansion step

#### Manual entry
- [ ] Select "None of these — enter details manually" from the BGG dropdown
- [ ] Fill in the modal (title, players, duration) and submit — confirm game card is posted
- [ ] Leave optional fields blank — confirm it posts without them

#### From outside an event channel
- [ ] Run `/game suggest title:Catan` from a non-event channel — confirm an event picker dropdown appears
- [ ] Select an event — confirm the suggest flow continues normally
- [ ] With multiple upcoming events, run `/game suggest` for a title that has no library match, select an event from the picker — confirm the BGG search dropdown appears next (regression: the event picker used to lose track of the typed title if it wasn't resolved as part of the same interaction, making it look like nothing happened after picking an event)
- [ ] Same as above but with a title that **is** an exact library match — confirm the game card posts directly (with the owner listed) right after picking the event, no extra step
- [ ] Restart/redeploy the bot between running `/game suggest` (before picking an event) and selecting an event from the picker — confirm the picker still resolves the original title correctly afterward (the title/expansion choice now travels with the dropdown itself rather than living in the bot process's memory)
- [ ] Select an event from the picker for a lineup that has already locked (4.7) — confirm the same "lineup is locked" message you'd get from suggesting directly in that event's channel

### 1.3b `/game list`

**What it does:** Lists all games suggested for the current event channel with player count, duration, and seats. Must be used inside an event channel.

- [ ] Run `/game list` in an event channel with games — confirm all games appear with stats and jump links
- [ ] Run `/game list` in a channel with no games — confirm "No games have been added yet"
- [ ] Run `/game list` in a non-event channel (e.g. general) — confirm helpful error: "Use `/game list` inside an event channel…"

### 1.3c `/game cancel`

**What it does:** Removes a game suggestion from the lineup. The person who suggested the game, that event's host, or an admin can remove it via this command. If the given title isn't an exact match, falls back to a fuzzy match against the current lineup (e.g. `catan` matches "Settlers of Catan").

- [ ] Remove your own game suggestion: `/game cancel title:Wingspan` — confirm card is deleted
- [ ] Remove your own game suggestion using a partial/fuzzy title, e.g. `/game cancel title:catan` when "Settlers of Catan" is in the lineup — confirm it's found and removed
- [ ] With two similarly-named games in the lineup (e.g. "Wingspan" and "Wingspan: Asia"), run `/game cancel title:wing` — confirm the bot asks you to be more specific instead of guessing, and neither game is removed
- [ ] Attempt to remove another user's suggestion as a regular member who is not that event's host — confirm "Only the person who suggested..., the event host, or an admin can remove it." error
- [ ] Attempt to cancel a game not in the lineup (no exact or fuzzy match) — confirm "No game called X found" error

### 1.3d Game Card Buttons — Join / Leave

**What it does:** Players click Join to take a seat in a game, Leave to vacate it.

- [ ] Click **Join** on a game card — confirm name appears in the seats list and count updates
- [ ] Click **Join** again on the same game — confirm "You're already in this game" error
- [ ] Click **Leave** — confirm name is removed and count updates
- [ ] Click **Leave** without being in the game — confirm "You're not in this game" error
- [ ] Fill all seats to the max player count — confirm the Join button becomes the Waitlist button

### 1.3e Game Card Buttons — Waitlist

**What it does:** When a game is full, players join a waitlist. If the waitlist reaches the minimum player count, the request pin is updated to reflect 2 copies needed — and if that game has a `/library request` (1.4h) outstanding, the bot automatically asks one more attending owner (load-balanced, excluding anyone already asked/confirmed/declined) to bring a second copy, the same "🎲 ... ✅ Confirm bringing / ❌ Can't bring it" DM as the initial request. If the waitlist later drops back below the threshold, that extra ask is retracted — its DM is edited to say it's no longer needed and its buttons removed — rather than left outstanding. When a seated player leaves and the game is full, the first waitlisted player is automatically promoted into the freed seat and removed from the waitlist (they get a DM if their DMs are open).

- [ ] Fill a game to max players, then click **Join Waitlist** — confirm added to waitlist section
- [ ] Click **Join Waitlist** when already on waitlist — confirm "You're already on the waitlist" error
- [ ] Click **Join Waitlist** when a seat is still available — confirm "There's still an open seat" error
- [ ] Add enough players to the waitlist to reach the minimum player count, with a `/library request` (1.4h) already outstanding for that game and 2+ attending owners — confirm the request pin updates to show "X/2 copies confirmed" and a second attending owner receives a "please bring a copy" DM
- [ ] Do the same with only 1 owner attending — confirm the pin still shows the updated copy count, but no second DM is sent (no eligible second owner to ask)
- [ ] Click **Leave Waitlist** — confirm removed from waitlist
- [ ] Dropping below min players on waitlist, with a second owner's ask still outstanding (unconfirmed) — confirm the pin reverts to 1 copy needed and that owner's DM is edited to say it's no longer needed, with its buttons removed
- [ ] Dropping below min players after the second owner already confirmed — confirm the pin reverts to 1 copy needed but the existing confirmation is left alone (a harmless extra confirmed copy), not retracted
- [ ] With a full game and at least one person on the waitlist, have a seated player click **Leave** — confirm the first waitlisted person is moved into the freed seat, removed from the waitlist list, and (if their DMs are open) receives a DM saying a seat opened up
- [ ] Do the same when promoting the waitlist below the minimum player count drops it back below 2 groups — confirm the request pin reverts to 1 copy needed

### 1.3f Bring Confirm / Cancel

**What it does:** After adding a game via BGG or manual entry, the bot asks if you're bringing the game. Confirming adds it to your library.

- [ ] After suggesting a BGG game, click **Yes, I'll bring it** — confirm game is added to your library (check with `/library mine`)
- [ ] Click **No** — confirm the game is still in the lineup but not added to your library

### 1.3g `/game bgstats`

**What it does:** Generates a QR code (and, for small enough tables — or always, if `SHORT_LINK_BASE_URL` is configured, see 4.7a — a "Log in BG Stats" button) for one of the current channel's suggested games, pre-filled with that game, its seated players, and a location — useful for a one-off play (especially in `/room` private rooms, which have no automatic scheduler pass). Works the same in event channels and private rooms; anyone who can see the game card can run it, not just its creator.

- [ ] With `SHORT_LINK_BASE_URL` configured (4.7a), run `/game bgstats title:Wingspan` in an event channel with players seated — confirm a public reply with a "📊 Log in BG Stats" button and a QR code image, regardless of how many players are seated
- [ ] Confirm the button opens BG Stats (or, pasted/decoded, contains) the correct game, the event's configured location, and the seated players
- [ ] Without `SHORT_LINK_BASE_URL` configured, run the same command — confirm the button is **omitted** (BG Stats' full payload, including the fields it requires per player/game, exceeds Discord's 512-char button limit even for a solo play) but the QR code is still present, and the reply text explains why there's no button
- [ ] Confirm the QR code decodes to (or, via the short link, redirects to) the exact same play details the button would have used, regardless of player count
- [ ] Scan the QR code (or tap the button) and confirm BG Stats opens the pre-filled play screen without an "Invalid data" JSON error (regression: BG Stats' Android app requires explicit `winner`, `startPlayer`, `highestWins`, and `noPoints` values, even though all four are documented as optional)
- [ ] For a game with a BGG id, confirm BG Stats opens successfully on iOS **and** macOS/Mac Catalyst without crashing (regression: `game.bggId` was sent as a quoted JSON string instead of the number BG Stats' schema expects, which threw a Core Data type-coercion exception — crashed outright on macOS, and silently closed the app on iOS)
- [ ] For a seated player with a linked BGG account (`/bgg link`), confirm their BGG username appears instead of their Discord display name
- [ ] Run `/game bgstats title:Wingspan location:Sean's place` — confirm the supplied location overrides the event's default
- [ ] Run the same command inside a `/room`-created private room with a suggested game — confirm it works identically, and that location is blank unless the `location` option is given (rooms have no location of their own)
- [ ] Run with a title that doesn't match any suggested game — confirm a clear ephemeral "No game called... found" error listing current games

### 1.3h Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" message with three buttons — 🎲 Suggest a Game, 🙋 Request a Game to Bring, 📋 My Games to Bring — posted automatically in the event channel the moment it's created, alongside (not replacing) the existing plain-text welcome message. Built for members on mobile who'd rather tap a button than learn/type a slash command; each button leads to the exact same result as its slash-command equivalent, just entered via a modal (popup text form) instead of command options. Because the hub only ever lives inside one specific event channel, it always resolves that event directly from the channel — there's no event picker step here, unlike running the bare slash commands outside an event channel.

- [ ] Create a new event — confirm the "🎮 Quick Actions" message appears in the new event channel, pinned, alongside the separate plain-text welcome message
- [ ] Tap "🎲 Suggest a Game" — confirm a modal pops up asking for a game title
- [ ] Submit the modal with a game already in the group library — confirm it's added to the lineup exactly as `/game suggest` would (posts a game card, same duplicate-detection, same "owner must be attending" check)
- [ ] Submit the modal with a title not in the library — confirm it falls through to the BGG search flow, same as `/game suggest`
- [ ] Submit the modal with a title already suggested for this event — confirm the same "already in the lineup" message `/game suggest` gives, with a jump link to the existing card
- [ ] Tap "🙋 Request a Game to Bring" — confirm a modal pops up asking for a game name
- [ ] Submit the modal with a game in the group library whose owner is attending — confirm the request is created and the assigned owner gets DMed, identical to `/library request`
- [ ] Submit the modal with a game not in the library, or whose owner(s) aren't attending — confirm the same error messages `/library request` gives
- [ ] Tap "📋 My Games to Bring" — confirm it shows the same ephemeral embed `/library bring` (no game param) shows for this event, listing only requests tied to games you (or a linked delegate) own
- [ ] Tap "📋 My Games to Bring" with nothing of yours requested — confirm "None of your games have been requested for this event"
- [ ] Manually un-pin the hub message — confirm it stays unpinned afterward (known limitation: unlike the Game Lineup/Games to Bring pins, which refresh and re-pin on every suggest/request, nothing currently re-triggers the hub pin after event creation, so there's no later action that would restore it)

## 1.4 `/library` — Game Library

### 1.4a `/library add`

**What it does:** Adds a game you own to the shared library. Follows a priority order: checks your own library, then the group library, then the BGG catalog. When BGG finds an exact match, shows a confirm prompt before adding so the user can verify it's the right game.

#### Basic add — already owned
- [ ] `/library add game:Wingspan` when you already own it — confirm "already in your library" duplicate message
- [ ] Case-insensitive: `/library add game:wingspan` when you own "Wingspan" — same duplicate message
- [ ] `/library add game:Wingspan` when a member who's linked you as a delegate (1.4n) owns it, and you don't — confirm `**Wingspan** is already in your library (shared from <@owner>'s library).` rather than the "adding your copy?" prompt

#### Others already own the game
- [ ] When another user owns the game (exact name match), confirm "already in the group library — adding your copy?" prompt with **Yes, add my copy** and **Cancel** buttons
- [ ] Click **Yes, add my copy** — confirm game is added
- [ ] Confirm this "adding your copy?" prompt still appears for a stranger's matching entry when there's no library link between you — linking only changes the behavior for linked delegates (see 1.4n)

#### Partial match in group library
- [ ] `/library add game:wing` when "Wingspan" is in the group library — confirm a "similar games in the group library" select menu appears
- [ ] Select a match — confirm "adding your copy?" flow
- [ ] Select "None of these — search BGG" — confirm BGG catalog search continues
- [ ] `/library add game:wing` where the only "Wingspan" entry in the group library is owned by a member who's linked you as a delegate (1.4n) — select it from the dropdown — confirm "already in your library (shared from @owner's library)" instead of the "adding your copy?" flow

#### BGG exact match (confirm prompt)
- [ ] `/library add game:Wingspan` on an empty library — confirm a "Found **Wingspan** on BGG — is that the game?" confirm prompt appears
- [ ] Click **Yes** — confirm game is added with BGG details; no "add details" modal appears
- [ ] Click **No** — confirm BGG is dismissed and the "add details" modal appears for custom entry

#### BGG multiple matches (select UI)
- [ ] `/library add game:arkham` — confirm a "which did you mean?" select menu appears
- [ ] Select a game from the dropdown — confirm the BGG confirm prompt appears
- [ ] Confirm **Yes** — confirm game is added with BGG details
- [ ] Search a very generic term with many BGG matches — confirm the dropdown is capped at Discord's 25-option select menu limit rather than erroring

#### No matches anywhere — custom game
- [ ] `/library add game:My Custom Game` with nothing matching anywhere — confirm game is added immediately and the "add details" modal appears

### 1.4b `/library remove`

**What it does:** Removes one of your games from the library. Supports fuzzy/partial name matching.

- [ ] `/library remove game:Catan` (exact match) — confirm "Removed **Catan** from your library"
- [ ] `/library remove game:cat` (partial match for "Catan") — confirm a select menu of matching games appears
- [ ] Select a game from the partial match menu — confirm it is removed
- [ ] Attempt to remove a game not in your library — confirm "not found" error

### 1.4c `/library mine`

**What it does:** Lists all base games you've added to the library, plus any linked delegates' games. Expansions imported via `/library import bgg` are excluded. Paginates with Previous/Next buttons when large (same pattern as `/library list`, 1.4d) — a member linked to several delegates' libraries can easily exceed a single embed field's capacity.

- [ ] Run `/library mine` with games added — confirm all your base games are listed
- [ ] If you have imported BGG expansions — confirm they do NOT appear in `/library mine`
- [ ] Run `/library mine` with no games — confirm "You haven't added any games" message
- [ ] With another member's library linked to you as a delegate (1.4n), run `/library mine` — confirm their games appear alongside your own, each marked `*(shared from <@ownerId>)*`
- [ ] With enough games (yours plus any linked delegates') to exceed one page:
  - [ ] Confirm **← Previous** and **Next →** buttons appear, with a "Page X of Y" indicator between them
  - [ ] **← Previous** is disabled on the first page
  - [ ] Click **Next →** — confirm page 2 is shown with different games
  - [ ] **Next →** is disabled on the last page
  - [ ] Confirm no error occurs regardless of how large the combined list is (regression: this previously crashed once the list exceeded Discord's embed description limit)

### 1.4d `/library list`

**What it does:** Shows all base games in the library grouped by game with all owners listed. Paginates with Previous/Next buttons when large.

- [ ] Run `/library list` — confirm all library base games appear with owners
- [ ] Confirm games with complexity set show 🟢/🟡/🔴 icons before the name
- [ ] Games without complexity data should appear without an icon
- [ ] Run with an empty library — confirm "No games in the library yet"
- [ ] With a large library:
  - [ ] Confirm **← Previous** and **Next →** buttons appear
  - [ ] **← Previous** is disabled on the first page
  - [ ] Click **Next →** — confirm page 2 is shown
  - [ ] **Next →** is disabled on the last page

### 1.4e `/library view`

**What it does:** Shows full details for a specific game. Lazily enriches from BGG on first view (tags, expansions, weight, complexity, best player count, how-to-play video, thumbnail).

- [ ] `/library view game:Root` — confirm embed shows player range, best player count, play time, complexity with role mention, tags, Resources field (how-to-play link + BGG files link), thumbnail in top-right, and Powered by BGG logo
- [ ] View a game with no BGG data — confirm enrichment runs and data appears
- [ ] View a game where you are an owner — confirm edit footer hint appears
- [ ] View a game that doesn't exist — confirm "not found" message

### 1.4f `/library edit`

**What it does:** Lets you update the details of a game you own (player count, play time, tags, expansions, and complexity). Every field in the modal is pre-filled with its current value, so deleting a field's text and saving clears that field rather than leaving the old value in place.

- [ ] `/library edit game:Wingspan` — confirm the edit modal appears, pre-filled with the game's current values
- [ ] Update player range, save — confirm updated values appear in `/library view`
- [ ] Set an expansion you own (e.g. `Prelude`), save, then re-open `/library edit` and clear the Expansions field entirely — confirm `/library view` no longer lists any expansions
- [ ] Clear the player range, play time, tags, and complexity fields (leave every field blank), save — confirm `/library view` shows none of those values set, rather than the previous ones
- [ ] Set Complexity to `Medium` — confirm 🟡 icon appears in `/library list`
- [ ] Set Complexity to `light` (lowercase) — confirm it is accepted and normalized to `Light`
- [ ] Set Complexity to an invalid value (e.g. `Extreme`) — confirm a warning is shown and the previous value is kept
- [ ] Attempt to edit a game you don't own — confirm permission error

### 1.4g `/library clear`

**What it does:** Removes all of your own games from the library. Self-only — cannot target another user. Admins can clear another user's library via `/admin library clear`.

- [ ] Run `/library clear` — confirm all your own games are removed (verify with `/library mine`)
- [ ] Run with no games in your library — confirm "You have no games in the library to remove"
- [ ] Confirm a regular user cannot clear another user's library via this command

### 1.4h `/library request`

**What it does:** Requests a specific game be brought to an event. No "please bring this" DM goes out yet — asking is deferred until the event's lineup locks (4.7), so the bot can pick fairly from each owner's *final* confirmed-brings count instead of an early, mostly-arbitrary snapshot. At lock, the request is asked of the owner the copy-select assigned it to (an explicit pick), or — when no copy-select is shown, or **Bot decides** was selected — whichever attending owner currently has the fewest confirmed brings for that event, with "🎲 ... ✅ Confirm bringing" and "❌ Can't bring it" buttons. Confirming behaves the same as `/library bring game:<name>`; declining cascades the same DM to the next eligible attending owner (see "Declining via the DM button" below). If the waitlist for a suggested game grows enough to need a second copy (1.3e/2.3e/3.3e), that just updates how many owners get asked at lock — it doesn't trigger an ask itself. A request made *after* the lineup is already locked has no future lock to wait for, so it's asked immediately instead.

**Prerequisites:** an active event must exist, and the game being requested must already be in the library, owned by someone who has RSVP'd (see 1.4a/2.4a/3.4a to add a game first).

#### Basic request (no expansions in library)
- [ ] `/library request game:Catan` from a non-event channel — confirm request targets the soonest upcoming event
- [ ] `/library request game:Catan` from inside a specific event channel — confirm request targets that event
- [ ] Request the same game twice — confirm duplicate is blocked
- [ ] None of the game's owners are RSVP'd — confirm "None of the owners are attending" error
- [ ] The literal owner has NOT RSVP'd, but a member they've linked as a delegate (1.4n) has RSVP'd yes/maybe — confirm the request still succeeds instead of hitting "None of the owners are attending"
- [ ] On an event whose lineup hasn't locked yet, confirm no DM is sent to anyone, and the reply notes "An owner will be asked to bring it once the lineup locks"
- [ ] Force the lineup to lock (4.7), then confirm the assigned owner receives a DM with a "✅ Confirm bringing" button for the requested game (include any owned expansions in the DM text)
- [ ] With 2+ attending owners and no expansion copy-select shown, confirm the DM (once sent, at lock) goes to whichever owner currently has the fewest confirmed brings for that event, not just the first owner alphabetically/by id
- [ ] Request a game on an event whose lineup is **already locked** — confirm the DM goes out immediately (no deferral) since there's no future lock left to wait for

#### Request with expansion copy select
- [ ] Request a game where at least one attending owner has expansions — confirm "Which copy would you like?" select appears
- [ ] Select a specific owner's copy — confirm announcement includes "— bringing: @owner" immediately, but (pre-lock) that owner doesn't receive the DM until the lineup locks
- [ ] Select **Bot decides** — confirm no owner is chosen or announced yet (no "— bringing: @owner" in the reply); once the lineup locks, confirm the bot then assigns the owner with fewest confirmed brings and DMs them

#### Confirming via the DM button
- [ ] Tap "✅ Confirm bringing" in the DM — confirm it behaves the same as `/library bring game:<name>` (message edits to show confirmed, ✅ appears next to the game in the event's request pin)
- [ ] Tap the DM button as an account that no longer owns the requested game — confirm "You can only confirm bringing games you own" reply, and the request is **not** marked confirmed
- [ ] Confirm the same request via `/library bring game:<name>` instead of the DM button — confirm the earlier DM is edited afterward to note "Confirmed via /library bring", with its button removed
- [ ] Tap a "please bring this" DM button for a request that's since been dropped (e.g. the game ended up with zero seated players at lock, 4.7) — confirm a graceful "no longer exists" edit rather than an error or a duplicate confirmation

#### Declining via the DM button
- [ ] Tap "❌ Can't bring it" in the DM — confirm the message updates to a "No problem" acknowledgment with buttons removed, and (with a second attending owner available) that owner receives the same "please bring this" DM
- [ ] Decline with no other attending owner left to ask — confirm the decline itself still succeeds (no error), just with nobody left to cascade to; the request pin's copy count reflects the shortfall
- [ ] Tap "❌ Can't bring it" a second time (or on a stale/forwarded DM) after already declining — confirm "You weren't asked to bring this one" rather than a duplicate decline or a crash
- [ ] Tap "❌ Can't bring it" on a request that's since been dropped — confirm the same graceful "no longer exists" edit as the confirm button

### 1.4i `/library unrequest`

**What it does:** Cancels your own game requests for an event. Self-only — shows only your own requests. Hosts can remove any request via `/host library unrequest`.

- [ ] Run `/library unrequest` inside an event channel — confirm only your own requests appear in the select menu
- [ ] Select a request and remove it — confirm it disappears from the request pin
- [ ] Run `/library unrequest` with no personal requests — confirm "You haven't requested any games for this event"
- [ ] Run from outside an event channel — confirm event picker appears; selecting an event shows your requests for that event only
- [ ] 👑 Confirm regular users cannot see or remove other users' requests via this command (test account must have neither the Host role nor Manage Events permission — see note below)

### 1.4j `/library bring`

**What it does:** Shows which of your library games have been requested for upcoming events, or confirms you're bringing a game.

- [ ] Run `/library bring` — confirm only your games that have been requested appear
- [ ] Run `/library bring game:Root` (where Root is requested with your copy preferred) — confirm success message with expansion list
- [ ] Click Confirm — confirm ✅ appears next to the game in the event's request pin
- [ ] Run with a game that hasn't been requested — confirm "That game hasn't been requested" error
- [ ] As a member linked as a delegate (1.4n) of the owner whose copy was requested, run `/library bring` — confirm the owner's requested game appears in your view too, and `/library bring game:X` lets you see expansion availability and confirm bringing it exactly as if it were your own
- [ ] With a 2-copies-needed request (1.3e) where only one owner has confirmed, run `/library bring` view mode — confirm the line shows "X/2 copies confirmed" rather than a single ✅, both for the confirmed owner's own view and for the still-outstanding owner's view

### 1.4k `/library import`

#### `/library import bgg`

**What it does:** Imports all owned games and expansions from your linked BoardGameGeek collection.

- [ ] Run without a linked BGG account — confirm "You don't have a BoardGameGeek account linked" error
- [ ] Run with a linked account — confirm success message with game/expansion counts
- [ ] Run a second time — confirm all entries show as "already in your library" (no duplicates)

#### `/library import csv`

**What it does:** Bulk-imports games from a CSV file. Available to any server member.

- [ ] Run `/library import csv` with a valid CSV — confirm games are added
- [ ] Run with malformed CSV — confirm appropriate error message
- [ ] Run with a CSV containing duplicate rows for the same game — confirm no duplicate library entries are created

### 1.4l `/library search`

**What it does:** Searches the library with filters for player count, tags, duration, and complexity. If no `tag`/`tag2`/`tag3` or `complexity` option is given, it defaults to your own `/myroles` preferences (1.5) instead of requiring you to type them every time.

- [ ] `/library search players:4` — confirm results include games supporting 4 players, sorted by proximity to 4
- [ ] `/library search players:2,4` (multiple counts) — confirm games matching either count appear
- [ ] `/library search tag:Co-op` — confirm only Co-op tagged games appear
- [ ] `/library search tag:Co-op tag2:Party` — confirm results include games matching EITHER tag (OR logic across tag/tag2/tag3)
- [ ] `/library search tag:Co-op tag2:Party tag3:Strategy` — confirm all three tags are OR'd together
- [ ] `/library search duration:60` — confirm games with play time within ±15 minutes of 60 appear
- [ ] `/library search min_duration:30` — confirm only games with play time ≥ 30 minutes appear
- [ ] `/library search max_duration:60` — confirm only games with play time ≤ 60 minutes appear
- [ ] `/library search min_duration:30 max_duration:60` — confirm only games within that exact range appear
- [ ] `/library search complexity:Light` — confirm only Light games appear
- [ ] Combine filters (e.g. `players`, `tag`, and `complexity` together) — confirm all filters apply together (AND across filter types, OR within tag1/2/3)
- [ ] Set genre/difficulty preferences via `/myroles` (1.5), then run `/library search` with no options at all — confirm it searches using those preferences instead of erroring, and the result description notes "(from your /myroles)"
- [ ] With `/myroles` preferences set, run `/library search tag:Party` (a tag different from your preference) — confirm the explicit tag wins over your preferences, with no "(from your /myroles)" note
- [ ] With no `/myroles` preferences set, run `/library search` with no options at all — confirm error: "Provide at least one valid filter: `players`, `tag`, or `duration` — or set your preferences with `/myroles` to search based on those."
- [ ] Search with valid filters but no matches — confirm "No games matched your filters"

### 1.4m `/library random`

**What it does:** Picks 3 random games from the library, optionally filtered by tags and complexity. If no `tag`/`tag2`/`tag3` or `complexity` option is given, it defaults to your own `/myroles` preferences (1.5) instead of picking from the whole library.

- [ ] `/library random` with no filters and no `/myroles` preferences set — confirm 3 fully random games are shown, with a footer tip to set `/myroles`
- [ ] `/library random tag:Co-op` — confirm all 3 results are Co-op tagged
- [ ] `/library random tag:Co-op tag2:Party` — confirm results match EITHER tag (OR logic across tag/tag2/tag3)
- [ ] `/library random complexity:Light` — confirm all 3 results are Light complexity
- [ ] `/library random tag:Co-op complexity:Heavy` — confirm results match the tag AND the complexity together
- [ ] Set genre/difficulty preferences via `/myroles` (1.5), then run `/library random` with no options at all — confirm the title includes "(from your /myroles)" and results are filtered to those preferences
- [ ] With `/myroles` preferences set, run `/library random complexity:Heavy` (different from your preference) — confirm the explicit complexity wins, with no "(from your /myroles)" note
- [ ] Filter for a tag/complexity combination with no matching games — confirm it falls back to 3 unfiltered random picks with a "No `<filter>` games found — here are 3 random picks instead" title
- [ ] Run multiple times — confirm different results each time

### 1.4n `/library link` / `/library unlink`

**What it does:** `/library link user:@X` grants @X delegate access to your library — they can view your games in their own `/library mine`, and can request/bring them, but this never gives them write access (add/remove/edit/clear) and never gives you access to theirs. It's one-directional: for two people to fully share with each other, each runs `/library link` once naming the other. `/library unlink user:@X` removes the link and can be run by either party.

- [ ] `/library link user:@Bob` (run by Alice) — confirm reply: "<@Bob> can now see your games in their `/library mine`, and can request/confirm bringing them. This only shares *your* library with them — if you'd like the same access to theirs, they'll need to run `/library link user:@you`."
- [ ] As Bob, run `/library mine` (1.4c) — confirm Alice's games now appear, marked `*(shared from <@Alice>)*`
- [ ] As Alice, run `/library mine` — confirm Bob's games do NOT appear — the link is one-directional, and Alice only granted access, she didn't receive any
- [ ] Run `/library link user:@Bob` again as Alice (already linked) — confirm reply: "<@Bob> can already view and manage bringing for your library." and no duplicate link is created
- [ ] `/library link user:@yourself` (target = yourself) — confirm "You can't link your own account to itself."
- [ ] `/library link user:@SomeBot` (target = a bot account) — confirm "You can't link a bot account."
- [ ] `/library unlink user:@Bob` run by Alice (the grantor) — confirm "Library link with <@Bob> removed." and Bob's `/library mine` no longer shows Alice's games
- [ ] Re-link Alice → Bob, then run `/library unlink user:@Alice` as Bob (the delegate, not the original grantor) — confirm the link is still removed even though Bob didn't create it
- [ ] `/library unlink user:@Carol` where no link exists between you and Carol — confirm "You don't have a library link with <@Carol>."
- [ ] With Alice → Bob and Alice → Carol both linked, run `/library unlink user:@Bob` — confirm only the Alice–Bob link is removed; Carol's shared access to Alice's library is unaffected

## 1.5 `/myroles` — Game Preferences

**What it does:** A 2-step interactive flow for members to set their difficulty preference and up to 5 genre tags. Roles are updated on Save.

### Prerequisites
- [ ] At least one game tag must exist (run `/admin tags sync` first)

### Test Cases

- [ ] Run `/myroles` — confirm Step 1 (difficulty) embed appears with difficulty buttons
- [ ] Click a difficulty button (e.g. Light) — confirm it highlights and updates the embed
- [ ] Click **Next: Pick Genres →** — confirm Step 2 (genre) embed appears
- [ ] Select up to 5 genre tags — confirm they highlight green
- [ ] Attempt to select a 6th genre — confirm buttons are disabled ("limit reached")
- [ ] Click **Save** — confirm roles are updated in the server
- [ ] Run `/myroles` again after saving — confirm existing roles are pre-selected

## 1.6 `/bgg` — BGG Account Linking

**What it does:** Lets members link their BoardGameGeek username to their Discord account on this server.

### 1.6a `/bgg link`
- [ ] Run `/bgg link username:validuser` — confirm BGG API validates and success embed appears with "Powered by BGG" logo
- [ ] Run `/bgg link username:nonexistentuser` — confirm "We couldn't verify that BoardGameGeek account" message
- [ ] Run with same username already linked — confirm "already linked" message

### 1.6b `/bgg unlink`
- [ ] Run after linking — confirm account is removed
- [ ] Run with no account linked — confirm "You don't have a BGG account linked" message

### 1.6c `/bgg profile`
- [ ] Run after linking — confirm embed shows linked username, BGG profile link, and linked date
- [ ] Run with no account linked — confirm helpful error with hint to use `/bgg link`

## 1.7 `/marketplace` — Community Marketplace

### 1.7a `/marketplace post sell`

**What it does:** Creates a for-sale listing, optionally enriched with BGG game details and current BGG marketplace price data.

**Prerequisites:** most cases below assume a marketplace channel is already configured via `/admin marketplace config` (3.9m) — the "no channel configured" case further down is intentionally tested without it.

- [ ] Run `/marketplace post sell item:Wingspan offers_allowed:true condition:Very Good` (renamed from `bids_allowed`) — confirm BGG price screen appears (ephemeral) with current marketplace prices and "Powered by BGG" logo
- [ ] Select a price option (use suggested, enter custom, or open to offers) — confirm forum post created with item name, price, a "Negotiable?" field showing "💬 Open to Offers", condition, and "I'm Interested" button
- [ ] Run with `offers_allowed:false` (renamed from `bids_allowed`) — confirm the listing embed's "Negotiable?" field shows "🔒 Firm Price" instead of "💬 Open to Offers", and the forum post now also shows a "⚡ Buy It Now" button alongside "I'm Interested" (see 5.1a for the full Buy It Now flow)
- [ ] Confirm the post-creation confirmation embed (shown right after posting) also has a "Negotiable?" field with the matching value ("💬 Open to Offers" / "🔒 Firm Price") — this field was previously named "Bids" with values "Allowed"/"Firm price"
- [ ] Select "List as open to offers" — confirm listing shows "Open to offers"
- [ ] Run with `notes` — confirm notes appear in the listing embed
- [ ] Confirm BGG thumbnail appears in the embed (if BGG found the item)
- [ ] Confirm "Powered by BGG" logo appears in the forum post embed
- [ ] Run when no marketplace channel is configured — confirm listing is still created, response notes no channel configured
- [ ] Run with an item that has expansions — confirm expansion select step appears; selecting expansions shows combined price estimate
- [ ] Run with an item that IS an expansion (e.g. `Wingspan: European Expansion`) — confirm the expansion-select step is **skipped**; instead a prompt asks whether to include the base game, with "✅ Include `<Base Game>`" and "➡️ Just the Expansion" buttons
- [ ] Choose to include the base game — confirm the price screen title includes "+ Base Game" and combines pricing for both items; the resulting listing embed's title also shows "+ Base Game" and includes an "Includes Base Game" field
- [ ] Choose "Just the Expansion" — confirm the listing posts normally with no base-game bundling; the embed still shows a "Base game on BGG" reference link, marked "(not included)"

#### Custom / non-BGG items
- [ ] Start typing an item name that has no BGG match, then select the "📝 not on BGG / custom item" autocomplete option — confirm no BGG price screen appears and you're instead prompted to add a reference link (**Add Link** / **Skip** buttons)
- [ ] Click **Add Link**, submit a URL in the modal — confirm the listing embed shows a "Reference link" entry pointing to that URL
- [ ] Click **Skip** — confirm the listing posts with no reference link and no BGG thumbnail
- [ ] Click **Add Link** and submit a non-URL string (e.g. plain text) — confirm graceful validation rather than a broken link field

### 1.7b `/marketplace post trade`

**What it does:** Creates a trade listing for an item you want to trade away.

- [ ] Run `/marketplace post trade item:Catan condition:Good looking_for:Wingspan` — confirm trade listing posted to forum with "For Trade" tag, an "Offering" field showing the item name, and a "Looking For" field showing "Wingspan" (the two fields display side by side)
- [ ] Confirm the post-creation confirmation embed ("Trade listing created — Catan") also shows the "Offering" field immediately before the "Looking For" field
- [ ] Run without `looking_for` — confirm listing shows "Open to offers"
- [ ] Confirm "I'm Interested" button appears on the forum post
- [ ] Select the "📝 not on BGG / custom item" autocomplete option — confirm the same Add Link / Skip reference-link flow as `/marketplace post sell` (see 1.7a) applies here too
- [ ] Run with an item that IS an expansion — confirm the same include-base-game prompt from `/marketplace post sell` (see 1.7a) appears before the trade listing is created

### 1.7c `/marketplace price`

**What it does:** Looks up current BGG marketplace prices for an item without creating a listing.

- [ ] Run `/marketplace price item:Wingspan` — confirm ephemeral embed shows price range, median, avg, distribution histogram, and "Powered by BGG" logo
- [ ] Run with an item that has expansions — confirm expansion select step appears; selecting expansions shows per-item breakdown and combined estimate with total listing count
- [ ] Run with an item that IS an expansion — confirm the include-base-game prompt appears instead of an expansion-select step; choosing to include the base game shows a per-item price breakdown including the base game
- [ ] Run with a custom/non-BGG item (type a name not in the catalog) — confirm "not in the BGG catalog" error
- [ ] Confirm no listing is created and nothing is posted to the marketplace channel

### 1.7d `/marketplace conditions`

**What it does:** Shows the condition grading scale used for marketplace listings.

- [ ] Run `/marketplace conditions` — confirm ephemeral embed appears with all five grades: New, Like New, Very Good, Good, Acceptable, each with a description
- [ ] Confirm the embed is only visible to the user who ran the command

### 1.7e `/marketplace browse`

**What it does:** Shows active listings in an ephemeral text list (up to 5 at a time).

- [ ] Run with no listings — confirm "No active listings found"
- [ ] Run with active listings — confirm list shows item name, price/offer, and seller username
- [ ] Run with a listing that has open offers — confirm the list shows an inline "(N offer(s))" annotation next to the price/offer for that listing
- [ ] Run with `type:sell` — confirm only sell listings appear
- [ ] Run with `type:trade` — confirm only trade listings appear
- [ ] Run with more than 5 active listings — confirm "Showing 5 of N. Check the marketplace channel for all listings."

### 1.7f `/marketplace my`

**What it does:** Shows your own listings with their status, offers, and IDs.

- [ ] Run with no listings — confirm "You don't have any listings"
- [ ] Run with listings — confirm all your listings are shown with status, price/offer, an "(N open offer(s))" annotation when offers are open, and listing ID

### 1.7g "I'm Interested" button flow

**What it does:** Buyer clicks button, modal opens, an offer is submitted, seller is notified. Firm-price listings also show a "Buy It Now" button that skips the seller-review step entirely.

**Requires a second account — moved to Part 5.1a.** This flow needs a distinct buyer and seller identity (you can't make an offer on your own listing, and Discord won't let an account DM itself), so it can't be exercised by one tester alone — see Part 5.1a below.

### 1.7h Negotiation — Accept / Deny / Counter

**What it does:** Seller responds to offers with Accept, Deny, or Counter buttons sent via DM (or thread fallback if DMs are disabled).

**Requires a second account — moved to Part 5.1b.** Accept/Deny/Counter is a live exchange between a seller's DM and a buyer's DM, so it needs two people/accounts watching for prompts around the same time — see Part 5.1b below.

### 1.7i Negotiation modes

**What it does:** Controls whether offer negotiation is visible publicly in the forum thread or in a private thread.

**Requires a second account — moved to Part 5.1c.** Verifying what each mode shows means comparing what the buyer's action produces against what the seller sees, which needs both identities — see Part 5.1c below.

### 1.7j `/marketplace close` and `/marketplace reopen`

**What it does:** Seller closes a listing; either party can reopen it if the deal falls through.

- [ ] Run `/marketplace close <id>` as the seller — confirm listing status becomes ⚫ Closed and forum post updates
- [ ] 👑 Run `/marketplace close <id>` as a different user (non-admin) — confirm "You can only close your own listings"
- [ ] Run `/marketplace reopen <id>` as the seller — confirm listing status returns to Active (or Pending if offers exist)
- [ ] Run `/marketplace reopen <id>` as a different user — confirm error

### 1.7k Transaction log

**What it does:** Every marketplace event is appended to `data/marketplace_log.jsonl`.

- [ ] After creating a listing, open `data/marketplace_log.jsonl` — confirm a `listing_created` entry with correct `guildId`, `listingId`, `listingName`, `actorId`, and `timestamp`
- [ ] After an offer is accepted, confirm `bid_accepted` and `listing_sold` entries appear
- [ ] After an offer is denied, confirm `bid_denied` entry appears
- [ ] Confirm no entries are missing for any action in the flow above

### 1.7l Permission boundaries (Regular Member)

- [ ] Confirm a regular member CAN use `post sell`, `post trade`, `price`, `conditions`, `browse`, `my`, `close` (own listings), `reopen` (own listings)
- [ ] 👑 Try `/admin marketplace config` and `/admin marketplace purge` as a regular member — confirm "requires Manage Server permission"

### 1.7m Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" **forum post** (not a plain channel message — forum channels pin threads, not messages) in the configured marketplace channel, with buttons for 📦 Sell an Item, 🔄 Propose a Trade, 🔍 Browse Listings, and 📋 My Listings. Created (or refreshed) automatically whenever `/admin marketplace config` (3.9m) sets the channel. Sell/Trade need an item name, which a modal only supports as free text (no autocomplete like the slash command's `item` option) — so the wizard collects the name via modal, then condition via a native select, then (sell only) offers-allowed via buttons, before handing off to the exact same listing-creation flow (BGG lookup, expansion select, price screen) the slash commands use. Trades skip the offers-allowed step since trades are always open to offers, same as `/marketplace post trade`.

**Prerequisites:** a marketplace channel configured via `/admin marketplace config` (3.9m).

- [ ] Configure the marketplace channel — confirm a "🎮 Quick Actions" post appears in the forum, pinned to the top
- [ ] Tap "📦 Sell an Item" — confirm a modal asks for an item name
- [ ] Submit the modal — confirm a condition select appears (New / Like New / Very Good / Good / Acceptable)
- [ ] Select a condition — confirm "✅ Allow Offers" / "🔒 Firm Price" buttons appear
- [ ] Tap either offers button — confirm it proceeds exactly like `/marketplace post sell` would from that point (BGG match on a base game → expansion select; BGG match on an expansion → include-base-game prompt; otherwise → price screen; no BGG match → reference-link prompt)
- [ ] Tap "🔄 Propose a Trade" — confirm a modal asks for an item name
- [ ] Submit the modal and select a condition — confirm it proceeds directly to the listing flow with **no** offers-allowed step, unlike the Sell wizard
- [ ] Tap "🔍 Browse Listings" — confirm it shows the same output as `/marketplace browse` with no type filter (all sell + trade listings)
- [ ] Tap "📋 My Listings" — confirm it shows the same output as `/marketplace my` for the tapping user
- [ ] Start the Sell (or Trade) wizard, then wait or restart the bot before finishing a step — confirm tapping a stale condition/offers button shows a "session has expired" message rather than an error or a crash

## 1.8 `/room` — Private Rooms

### 1.8a `/room create`

**What it does:** Creates a new private text channel visible only to whoever you mention, plus hosts and admins — hidden from everyone else. Posts a message pinging each invited person, and creates the channel under a separate category (default "Private Rooms", configurable via `/admin room config`, 3.9o) so it's never mixed in with event/archive channels. Requires a `date` (when the room auto-closes — see 4.8), unless `persist:true` is set, which creates a room with no expiration at all — see 1.8c to toggle this later. A persistent room's channel name and topic are prefixed with 📌 so hosts/admins can spot it in the channel list without opening it.

**Prerequisites:** none — any server member can run this, not just hosts/admins.

- [ ] Run `/room create people:@Alice @Bob date:August 22` — confirm a new channel is created under the "Private Rooms" category, and the ping message + confirmation both state it expires August 22
- [ ] Run `/room create people:@Alice persist:true` with no `date` — confirm the room is created with no expiration, the channel name and topic are prefixed with 📌, and the ping message + confirmation both say it persists until closed
- [ ] Confirm a normal (non-persistent) room's channel name and topic are **not** prefixed with 📌
- [ ] Attempt to create a room with neither `date` nor `persist:true` — confirm a clear "Provide a `date`..." error and no channel is created
- [ ] Run with an unparseable `date` (e.g. "whenever") — confirm a clear parse error and no channel is created
- [ ] Run with a `date` already in the past — confirm "That date has already passed" error and no channel is created
- [ ] Confirm the channel is hidden from `@everyone` — a member who wasn't mentioned and has no Host/Admin role cannot see it
- [ ] Confirm you (the creator), the mentioned people, and any Host/Admin role member can all see the channel
- [ ] Confirm a message posts in the new channel `@`mentioning each invited person
- [ ] Run with a `name` option — confirm the channel is named accordingly
- [ ] Run without a `name` option — confirm a reasonable auto-generated name is used instead
- [ ] Run with `people` containing no valid `@`mentions (e.g. plain text) — confirm a clear error and no channel is created
- [ ] Mention yourself along with others — confirm you aren't invited twice/duplicated
- [ ] Mention someone who has since left the server — confirm they're skipped with a note in the reply, and the room is still created for the remaining valid people
- [ ] Mention only people who've all left the server — confirm a clear "couldn't find any" error and no channel is created
- [ ] Create a second room in the same server — confirm it reuses the existing "Private Rooms" category rather than creating a duplicate

### 1.8b `/room close`

**What it does:** Deletes a private room. Must be run inside the room's own channel. The room's creator or any host/admin can close it — nobody else.

- [ ] Run inside a room you created — confirm the channel is deleted
- [ ] Run inside a room someone else created, as a Host or Admin — confirm it works
- [ ] Run inside a room someone else created, as a regular member with no elevated role — confirm "Only the room's creator or a host/admin can close this room" error, and the channel is **not** deleted
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 1.8c `/room persist`

**What it does:** Turns a private room's auto-expiration on (`enabled:true`) or off (`enabled:false`, requires a new `date`). Must be run inside the room's own channel. The room's creator or any host/admin can toggle it — nobody else. See 4.8 for how auto-expiration works. The channel's 📌 name/topic prefix updates immediately to match.

- [ ] Run `/room persist enabled:true` inside a room that has a `date` — confirm the reply says the room will no longer auto-expire, the channel name and topic gain the 📌 prefix, and it survives past its original expiration date
- [ ] Run `/room persist enabled:false` inside a persistent room, with a `date` — confirm the reply confirms the new expiration, the channel name and topic lose the 📌 prefix, and the room auto-closes on that date (4.8)
- [ ] Run `/room persist enabled:false` inside a persistent room, with **no** `date` — confirm a clear "Provide a `date`..." error and the room remains persistent
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can change this room's expiration" error, and nothing changes
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 1.8d `/room invite`

**What it does:** Adds more people to an existing private room, granting them channel access and updating the stored room record. Must be run inside the room's own channel. The room's creator or any host/admin can invite — nobody else.

- [ ] Run `/room invite people:@Carol` inside a room — confirm Carol gains access to the channel, is pinged in a message, and the confirmation reply says she was added
- [ ] Confirm the newly added person now shows up if the room is later inspected (e.g. they count toward "already in this room" on a repeat invite)
- [ ] Mention someone who's already the creator or an existing invitee — confirm a clear "isn't already in this room" error and no channel/reply changes
- [ ] Mention someone who has since left the server — confirm they're skipped with a note in the reply, and any other valid mentions are still added
- [ ] Mention only people who've all left the server — confirm a clear "couldn't find any" error
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can invite people to this room" error, and nobody is added
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 1.8e `/room kick`

**What it does:** Removes someone from an existing private room, revoking their channel access and updating the stored room record. Must be run inside the room's own channel. The room's creator or any host/admin can kick — nobody else. The room's creator cannot be kicked (close the room instead).

- [ ] Run `/room kick user:@Carol` inside a room Carol was invited to — confirm Carol loses access to the channel, a message announces her removal, and the confirmation reply says she was removed
- [ ] Attempt to kick the room's creator — confirm "You can't remove the room's creator..." error and nothing changes
- [ ] Attempt to kick someone who was never invited to this room — confirm a clear "hasn't been individually invited" error and nothing changes
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can remove people from this room" error, and nobody is removed
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 1.8f Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" message posted automatically the moment a room is created, alongside the existing plain-text welcome message — buttons for 🎲 Suggest a Game, ➕ Invite, 👢 Kick, 📌 Toggle Auto-Expire, and 🔒 Close Room. The Suggest a Game button is the exact same one used in event channels (same modal, same underlying flow) — it just resolves this room instead of an event when tapped here. Invite/Kick use Discord's native member-picker (a dropdown of server members) instead of typing mentions or a user option, and Close Room adds a Yes/Cancel confirmation step that the slash command itself doesn't have, since a misplaced tap is easier than a mistyped command for something this irreversible. Every button enforces the same "room creator or host/admin" permission check as its slash-command equivalent.

- [ ] Create a room — confirm the "🎮 Quick Actions" message appears, pinned, alongside the separate plain-text welcome message
- [ ] Tap "🎲 Suggest a Game" — confirm the same modal/flow as the event-channel hub, correctly suggesting into this room
- [ ] Tap "➕ Invite" as the room's creator — confirm a member-picker appears; selecting one or more people grants them channel access and adds them to the room, identical to `/room invite`
- [ ] Tap "➕ Invite" as a member with no elevated role who isn't the room's creator — confirm the same permission error `/room invite` gives
- [ ] Tap "👢 Kick" with nobody individually invited yet — confirm "Nobody has been individually invited to this room..." instead of an empty/broken picker
- [ ] Tap "👢 Kick" and select someone invited to the room — confirm they lose access, identical to `/room kick`
- [ ] Tap "👢 Kick" and select the room's creator — confirm "You can't remove the room's creator..." same as the command
- [ ] Tap "📌 Toggle Auto-Expire" on a room with a set expiration date — confirm it immediately becomes persistent (no modal), same as `/room persist enabled:true`
- [ ] Tap "📌 Toggle Auto-Expire" on a persistent room — confirm a modal asks for a new expiration date, and submitting it sets the date and turns persistence back off, same as `/room persist enabled:false date:...`
- [ ] Tap "🔒 Close Room" — confirm a "this cannot be undone" Yes/Cancel prompt appears rather than closing immediately
- [ ] Tap "Cancel" on that prompt — confirm the room stays open
- [ ] Tap "Yes, close this room" — confirm the room is closed and its channel deleted, identical to `/room close`

## 1.9 General Chat — Quick Actions Hub

### 1.9a Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" message in a designated, already-populated chat channel (e.g. #general) — set via `/admin general config` (3.9q). Unlike the event/room/marketplace hubs, this one isn't tied to any single command; it's a standalone panel of the most-used member actions that don't otherwise have a home: ✅ RSVP to Next Event, 📚 Browse Library, 📋 My Games, 🎲 Random Game, and 🙋 Request a Game to Bring. The Request button is the *exact same* `/library request` hub button used in event channels — since that flow already falls back to the soonest upcoming event when there's no specific event-channel context, it works correctly from any channel with no changes.

**Prerequisites:** a channel configured via `/admin general config` (3.9q).

- [ ] Configure the general hub channel — confirm the "🎮 Quick Actions" message appears there, pinned
- [ ] Tap "✅ RSVP to Next Event" with an upcoming event — confirm an ephemeral reply with a link button that jumps directly to that event's announcement post
- [ ] Tap "✅ RSVP to Next Event" with no upcoming events — confirm "There's no upcoming event to RSVP to yet" instead of an error
- [ ] With 2+ upcoming events, tap "✅ RSVP to Next Event" — confirm it jumps to the **soonest** one, not just the first one created
- [ ] Tap "📚 Browse Library" — confirm the same output as `/library list` (1.4a)
- [ ] Tap "📋 My Games" — confirm the same output as `/library mine` (1.4b), listing only your own (and shared-with-you) games
- [ ] Tap "🎲 Random Game" — confirm the same output as running `/library random` with no options, including the personalization fallback to your `/myroles` (1.5) preferences if set
- [ ] Tap "🙋 Request a Game to Bring" — confirm the same modal/flow as the event-channel hub (1.3h), targeting the soonest upcoming event since there's no specific event channel here

---

## 1.10 `/hub` — On-Demand Quick Actions

**What it does:** Every pinned "Quick Actions" hub (event, 1.3h; room, 1.8f; marketplace, 1.7m; general chat, 1.9a) is a standing message someone can scroll past or lose track of. `/hub` reposts the same buttons on demand as an ephemeral reply only the runner can see, by detecting which context the channel it's run in matches — no arguments needed. Reuses the exact same embed/button-building functions as each pinned hub, so the buttons behave identically (same customIds, same handlers).

- [ ] Run `/hub` inside a private room — confirm an ephemeral reply with the same embed/buttons as that room's pinned hub (1.8f)
- [ ] Run `/hub` inside an active event channel — confirm an ephemeral reply with the same embed/buttons as that event's pinned hub (1.3h)
- [ ] Run `/hub` inside a **cancelled or archived** event's channel — confirm it falls through to the "no hub for this channel" message rather than showing a stale event hub
- [ ] Run `/hub` inside the marketplace's pinned hub thread (Forum mode) — confirm an ephemeral reply with the same embed/buttons as the marketplace hub (1.7m)
- [ ] Run `/hub` directly in the marketplace channel (Text mode — no separate hub thread, so this must match on the channel itself) — confirm the same ephemeral marketplace hub reply
- [ ] Run `/hub` inside the configured general-chat hub channel (3.9q) — confirm an ephemeral reply with the same embed/buttons as the general hub (1.9a)
- [ ] Run `/hub` in any other channel (not a room, event, marketplace hub thread, or configured general channel) — confirm a graceful ephemeral message explaining no hub applies here, rather than an error
- [ ] Confirm every button on the `/hub` reply works exactly the same as tapping it on the pinned message (same handlers, same customIds)

---

# Part 2 — Host Tests (Host role / Manage Events permission)

Hosts retain full Regular Member access, so this part fully repeats Part 1's checks (run them against a Host-role account) before adding the Host-only commands in 2.8.

## 2.1 `/help`

**What it does:** Displays an ephemeral embed listing all available commands, tier-filtered to the invoking user's permissions.

- [ ] 👑 Run `/help` as a host — confirm the **🎪 /host** section appears in addition to user commands, but **no Admin section**
- [ ] Confirm `/game cancel` description says "Remove your own game suggestion"
- [ ] Confirm `/library clear` description says "Remove all your own games at once"
- [ ] Confirm the response is ephemeral
- [ ] Confirm `/host` commands **are visible** in the Discord slash command picker; `/admin` commands are **not**

## 2.2 `/event` — Event Viewing

### 2.2a `/event list`

**What it does:** Lists all upcoming (non-cancelled, non-archived) game nights with IDs, dates, times, and RSVP counts.

- [ ] With at least one active event — confirm it shows the event with its ID and details
- [ ] With no active events — confirm it shows "No upcoming game nights scheduled"
- [ ] Confirm the response is ephemeral

### 2.2b RSVP Buttons

**What it does:** Members click Going / Maybe / Can't Go on the RSVP embed to update their RSVP status. In RSVP-only mode, Going/Maybe grants access to the event channel.

**Prerequisites:** an event must already exist with its RSVP embed posted (created via `/host event create`, 2.8a) — see the global Prerequisites section above.

- [ ] Click **Going** — confirm:
  - RSVP count updates in the embed
  - Member gains access to the event channel (if RSVP-only mode)
- [ ] Click **Maybe** — confirm similar behavior to Going
- [ ] Click **Can't Go** — confirm:
  - RSVP count updates
  - Member loses access to the event channel (if RSVP-only mode)
- [ ] Toggle between statuses (Going → Maybe → Can't Go → Going) — confirm counts stay accurate
- [ ] Remove "Interested" from the Discord scheduled event directly — confirm bot marks user as Can't Go

## 2.3 `/game` — Game Suggestions

All `/game` commands should be used inside an active event channel unless otherwise noted.

### 2.3a `/game suggest`

**What it does:** Suggests a game for the event (or, from inside a private room, for that room — see below). Checks the group library first (exact match → partial match → BGG search). Prompts to add tags if not already tagged.

#### From a private room
- [ ] Run `/game suggest title:Wingspan` from inside a `/room`-created private room channel (1.8a) — confirm it posts the game card directly in the room, with no event picker
- [ ] Suggest a library game whose owner is a member of the room but not attending any event — confirm it's allowed (attendance is checked against room membership, not event RSVPs)
- [ ] Suggest a library game whose owner is **not** a member of the room — confirm "None of the owners are attending" error, same wording as the event case
- [ ] Confirm Join/Leave buttons on a room-suggested game card work the same as in an event channel
- [ ] Confirm suggesting in a room does **not** create a request-pin or lineup-pin entry — "bring to a future event" tracking doesn't apply to an ad-hoc room

#### From a library game (exact match)
- [ ] Add a game to your library first (`/library add game:Wingspan`)
- [ ] RSVP Going to the event
- [ ] Run `/game suggest title:Wingspan` — confirm game card appears in the event channel with owner listed
- [ ] Confirm the suggester is automatically shown as a seated player on the game card
- [ ] Confirm the tag picker appears if the game has no tags set
- [ ] Try suggesting the same game again — confirm "already in the lineup" duplicate error

#### From a library game (partial match)
- [ ] Run `/game suggest title:Wing` (partial) — confirm a dropdown appears with library matches and a "Search BGG instead" option
- [ ] Select a match from the dropdown — confirm the game is added

#### Game owner not attending
- [ ] Attempt to suggest a game where the owner has not RSVP'd — confirm "None of the owners are attending" error

#### From BGG search
- [ ] Run `/game suggest title:Ticket to Ride` — confirm BGG results dropdown appears
- [ ] Confirm results are sorted newest publish year first
- [ ] Select a result — confirm game card is posted with BGG-sourced data
- [ ] If the BGG game has no tags — confirm tag picker appears
- [ ] Select tags, click Save — confirm tags appear on the game card and prompt to confirm bringing the game
- [ ] Click Skip on tag picker — confirm bring prompt appears
- [ ] Search a generic term with more than 24 BGG matches — confirm **← Previous** / **Page X of Y** / **Next →** buttons appear below the dropdown, with Previous disabled on page 1
- [ ] Click **Next →** — confirm the dropdown updates to the next page of results (newest-first order continues across pages) and **Previous** becomes enabled
- [ ] Navigate to the last page — confirm **Next →** is disabled
- [ ] Search a term with 24 or fewer matches — confirm no pagination buttons appear (dropdown only)

#### With expansions
- [ ] Run `/game suggest title:Wingspan with_expansions:True`
- [ ] Select the game from BGG results — confirm expansion selection dropdown appears
- [ ] Select expansions and confirm — confirm game card shows expansions
- [ ] If a game has no expansions — confirm it posts directly without the expansion step

#### Manual entry
- [ ] Select "None of these — enter details manually" from the BGG dropdown
- [ ] Fill in the modal (title, players, duration) and submit — confirm game card is posted
- [ ] Leave optional fields blank — confirm it posts without them

#### From outside an event channel
- [ ] Run `/game suggest title:Catan` from a non-event channel — confirm an event picker dropdown appears
- [ ] Select an event — confirm the suggest flow continues normally
- [ ] With multiple upcoming events, run `/game suggest` for a title that has no library match, select an event from the picker — confirm the BGG search dropdown appears next (regression: the event picker used to lose track of the typed title if it wasn't resolved as part of the same interaction, making it look like nothing happened after picking an event)
- [ ] Same as above but with a title that **is** an exact library match — confirm the game card posts directly (with the owner listed) right after picking the event, no extra step
- [ ] Restart/redeploy the bot between running `/game suggest` (before picking an event) and selecting an event from the picker — confirm the picker still resolves the original title correctly afterward (the title/expansion choice now travels with the dropdown itself rather than living in the bot process's memory)
- [ ] Select an event from the picker for a lineup that has already locked (4.7) — confirm the same "lineup is locked" message you'd get from suggesting directly in that event's channel

### 2.3b `/game list`

**What it does:** Lists all games suggested for the current event channel with player count, duration, and seats. Must be used inside an event channel.

- [ ] Run `/game list` in an event channel with games — confirm all games appear with stats and jump links
- [ ] Run `/game list` in a channel with no games — confirm "No games have been added yet"
- [ ] Run `/game list` in a non-event channel (e.g. general) — confirm helpful error: "Use `/game list` inside an event channel…"

### 2.3c `/game cancel`

**What it does:** Removes a game suggestion from the lineup. The person who suggested the game, that event's host, or an admin can remove it via this command; hosts can also remove any game via `/host game cancel`. If the given title isn't an exact match, falls back to a fuzzy match against the current lineup (e.g. `catan` matches "Settlers of Catan").

- [ ] Remove your own game suggestion: `/game cancel title:Wingspan` — confirm card is deleted
- [ ] Remove your own game suggestion using a partial/fuzzy title, e.g. `/game cancel title:catan` when "Settlers of Catan" is in the lineup — confirm it's found and removed
- [ ] With two similarly-named games in the lineup (e.g. "Wingspan" and "Wingspan: Asia"), run `/game cancel title:wing` — confirm the bot asks you to be more specific instead of guessing, and neither game is removed
- [ ] As the host of this event, remove a game suggested by someone else via `/game cancel` (not `/host game cancel`) — confirm it succeeds instead of the suggester-only error
- [ ] Attempt to cancel a game not in the lineup (no exact or fuzzy match) — confirm "No game called X found" error

### 2.3d Game Card Buttons — Join / Leave

**What it does:** Players click Join to take a seat in a game, Leave to vacate it.

- [ ] Click **Join** on a game card — confirm name appears in the seats list and count updates
- [ ] Click **Join** again on the same game — confirm "You're already in this game" error
- [ ] Click **Leave** — confirm name is removed and count updates
- [ ] Click **Leave** without being in the game — confirm "You're not in this game" error
- [ ] Fill all seats to the max player count — confirm the Join button becomes the Waitlist button

### 2.3e Game Card Buttons — Waitlist

**What it does:** When a game is full, players join a waitlist. If the waitlist reaches the minimum player count, the request pin is updated to reflect 2 copies needed — and if that game has a `/library request` (1.4h) outstanding, the bot automatically asks one more attending owner (load-balanced, excluding anyone already asked/confirmed/declined) to bring a second copy, the same "🎲 ... ✅ Confirm bringing / ❌ Can't bring it" DM as the initial request. If the waitlist later drops back below the threshold, that extra ask is retracted — its DM is edited to say it's no longer needed and its buttons removed — rather than left outstanding. When a seated player leaves and the game is full, the first waitlisted player is automatically promoted into the freed seat and removed from the waitlist (they get a DM if their DMs are open).

- [ ] Fill a game to max players, then click **Join Waitlist** — confirm added to waitlist section
- [ ] Click **Join Waitlist** when already on waitlist — confirm "You're already on the waitlist" error
- [ ] Click **Join Waitlist** when a seat is still available — confirm "There's still an open seat" error
- [ ] Add enough players to the waitlist to reach the minimum player count, with a `/library request` (1.4h) already outstanding for that game and 2+ attending owners — confirm the request pin updates to show "X/2 copies confirmed" and a second attending owner receives a "please bring a copy" DM
- [ ] Do the same with only 1 owner attending — confirm the pin still shows the updated copy count, but no second DM is sent (no eligible second owner to ask)
- [ ] Click **Leave Waitlist** — confirm removed from waitlist
- [ ] Dropping below min players on waitlist, with a second owner's ask still outstanding (unconfirmed) — confirm the pin reverts to 1 copy needed and that owner's DM is edited to say it's no longer needed, with its buttons removed
- [ ] Dropping below min players after the second owner already confirmed — confirm the pin reverts to 1 copy needed but the existing confirmation is left alone (a harmless extra confirmed copy), not retracted
- [ ] With a full game and at least one person on the waitlist, have a seated player click **Leave** — confirm the first waitlisted person is moved into the freed seat, removed from the waitlist list, and (if their DMs are open) receives a DM saying a seat opened up
- [ ] Do the same when promoting the waitlist below the minimum player count drops it back below 2 groups — confirm the request pin reverts to 1 copy needed

### 2.3f Bring Confirm / Cancel

**What it does:** After adding a game via BGG or manual entry, the bot asks if you're bringing the game. Confirming adds it to your library.

- [ ] After suggesting a BGG game, click **Yes, I'll bring it** — confirm game is added to your library (check with `/library mine`)
- [ ] Click **No** — confirm the game is still in the lineup but not added to your library

## 2.4 `/library` — Game Library

### 2.4a `/library add`

**What it does:** Adds a game you own to the shared library. Follows a priority order: checks your own library, then the group library, then the BGG catalog. When BGG finds an exact match, shows a confirm prompt before adding so the user can verify it's the right game.

#### Basic add — already owned
- [ ] `/library add game:Wingspan` when you already own it — confirm "already in your library" duplicate message
- [ ] Case-insensitive: `/library add game:wingspan` when you own "Wingspan" — same duplicate message
- [ ] `/library add game:Wingspan` when a member who's linked you as a delegate (2.4n) owns it, and you don't — confirm `**Wingspan** is already in your library (shared from <@owner>'s library).` rather than the "adding your copy?" prompt

#### Others already own the game
- [ ] When another user owns the game (exact name match), confirm "already in the group library — adding your copy?" prompt with **Yes, add my copy** and **Cancel** buttons
- [ ] Click **Yes, add my copy** — confirm game is added
- [ ] Confirm this "adding your copy?" prompt still appears for a stranger's matching entry when there's no library link between you — linking only changes the behavior for linked delegates (see 2.4n)

#### Partial match in group library
- [ ] `/library add game:wing` when "Wingspan" is in the group library — confirm a "similar games in the group library" select menu appears
- [ ] Select a match — confirm "adding your copy?" flow
- [ ] Select "None of these — search BGG" — confirm BGG catalog search continues
- [ ] `/library add game:wing` where the only "Wingspan" entry in the group library is owned by a member who's linked you as a delegate (2.4n) — select it from the dropdown — confirm "already in your library (shared from @owner's library)" instead of the "adding your copy?" flow

#### BGG exact match (confirm prompt)
- [ ] `/library add game:Wingspan` on an empty library — confirm a "Found **Wingspan** on BGG — is that the game?" confirm prompt appears
- [ ] Click **Yes** — confirm game is added with BGG details; no "add details" modal appears
- [ ] Click **No** — confirm BGG is dismissed and the "add details" modal appears for custom entry

#### BGG multiple matches (select UI)
- [ ] `/library add game:arkham` — confirm a "which did you mean?" select menu appears
- [ ] Select a game from the dropdown — confirm the BGG confirm prompt appears
- [ ] Confirm **Yes** — confirm game is added with BGG details
- [ ] Search a very generic term with many BGG matches — confirm the dropdown is capped at Discord's 25-option select menu limit rather than erroring

#### No matches anywhere — custom game
- [ ] `/library add game:My Custom Game` with nothing matching anywhere — confirm game is added immediately and the "add details" modal appears

### 2.4b `/library remove`

**What it does:** Removes one of your games from the library. Supports fuzzy/partial name matching.

- [ ] `/library remove game:Catan` (exact match) — confirm "Removed **Catan** from your library"
- [ ] `/library remove game:cat` (partial match for "Catan") — confirm a select menu of matching games appears
- [ ] Select a game from the partial match menu — confirm it is removed
- [ ] Attempt to remove a game not in your library — confirm "not found" error

### 2.4c `/library mine`

**What it does:** Lists all base games you've added to the library, plus any linked delegates' games. Expansions imported via `/library import bgg` are excluded. Paginates with Previous/Next buttons when large (same pattern as `/library list`, 2.4d) — a member linked to several delegates' libraries can easily exceed a single embed field's capacity.

- [ ] Run `/library mine` with games added — confirm all your base games are listed
- [ ] If you have imported BGG expansions — confirm they do NOT appear in `/library mine`
- [ ] Run `/library mine` with no games — confirm "You haven't added any games" message
- [ ] With another member's library linked to you as a delegate (2.4n), run `/library mine` — confirm their games appear alongside your own, each marked `*(shared from <@ownerId>)*`
- [ ] With enough games (yours plus any linked delegates') to exceed one page:
  - [ ] Confirm **← Previous** and **Next →** buttons appear, with a "Page X of Y" indicator between them
  - [ ] **← Previous** is disabled on the first page
  - [ ] Click **Next →** — confirm page 2 is shown with different games
  - [ ] **Next →** is disabled on the last page
  - [ ] Confirm no error occurs regardless of how large the combined list is (regression: this previously crashed once the list exceeded Discord's embed description limit)

### 2.4d `/library list`

**What it does:** Shows all base games in the library grouped by game with all owners listed. Paginates with Previous/Next buttons when large.

- [ ] Run `/library list` — confirm all library base games appear with owners
- [ ] Confirm games with complexity set show 🟢/🟡/🔴 icons before the name
- [ ] Games without complexity data should appear without an icon
- [ ] Run with an empty library — confirm "No games in the library yet"
- [ ] With a large library:
  - [ ] Confirm **← Previous** and **Next →** buttons appear
  - [ ] **← Previous** is disabled on the first page
  - [ ] Click **Next →** — confirm page 2 is shown
  - [ ] **Next →** is disabled on the last page

### 2.4e `/library view`

**What it does:** Shows full details for a specific game. Lazily enriches from BGG on first view (tags, expansions, weight, complexity, best player count, how-to-play video, thumbnail).

- [ ] `/library view game:Root` — confirm embed shows player range, best player count, play time, complexity with role mention, tags, Resources field (how-to-play link + BGG files link), thumbnail in top-right, and Powered by BGG logo
- [ ] View a game with no BGG data — confirm enrichment runs and data appears
- [ ] View a game where you are an owner — confirm edit footer hint appears
- [ ] View a game that doesn't exist — confirm "not found" message

### 2.4f `/library edit`

**What it does:** Lets you update the details of a game you own (player count, play time, tags, expansions, and complexity). Every field in the modal is pre-filled with its current value, so deleting a field's text and saving clears that field rather than leaving the old value in place.

- [ ] `/library edit game:Wingspan` — confirm the edit modal appears, pre-filled with the game's current values
- [ ] Update player range, save — confirm updated values appear in `/library view`
- [ ] Set an expansion you own (e.g. `Prelude`), save, then re-open `/library edit` and clear the Expansions field entirely — confirm `/library view` no longer lists any expansions
- [ ] Clear the player range, play time, tags, and complexity fields (leave every field blank), save — confirm `/library view` shows none of those values set, rather than the previous ones
- [ ] Set Complexity to `Medium` — confirm 🟡 icon appears in `/library list`
- [ ] Set Complexity to `light` (lowercase) — confirm it is accepted and normalized to `Light`
- [ ] Set Complexity to an invalid value (e.g. `Extreme`) — confirm a warning is shown and the previous value is kept
- [ ] Attempt to edit a game you don't own — confirm permission error

### 2.4g `/library clear`

**What it does:** Removes all of your own games from the library. Self-only — cannot target another user. Admins can clear another user's library via `/admin library clear`.

- [ ] Run `/library clear` — confirm all your own games are removed (verify with `/library mine`)
- [ ] Run with no games in your library — confirm "You have no games in the library to remove"
- [ ] Confirm a host cannot clear another user's library via this command

### 2.4h `/library request`

**What it does:** Requests a specific game be brought to an event. No "please bring this" DM goes out yet — asking is deferred until the event's lineup locks (4.7), so the bot can pick fairly from each owner's *final* confirmed-brings count instead of an early, mostly-arbitrary snapshot. At lock, the request is asked of the owner the copy-select assigned it to (an explicit pick), or — when no copy-select is shown, or **Bot decides** was selected — whichever attending owner currently has the fewest confirmed brings for that event, with "🎲 ... ✅ Confirm bringing" and "❌ Can't bring it" buttons. Confirming behaves the same as `/library bring game:<name>`; declining cascades the same DM to the next eligible attending owner (see "Declining via the DM button" below). If the waitlist for a suggested game grows enough to need a second copy (1.3e/2.3e/3.3e), that just updates how many owners get asked at lock — it doesn't trigger an ask itself. A request made *after* the lineup is already locked has no future lock to wait for, so it's asked immediately instead.

**Prerequisites:** an active event must exist, and the game being requested must already be in the library, owned by someone who has RSVP'd (see 1.4a/2.4a/3.4a to add a game first).

#### Basic request (no expansions in library)
- [ ] `/library request game:Catan` from a non-event channel — confirm request targets the soonest upcoming event
- [ ] `/library request game:Catan` from inside a specific event channel — confirm request targets that event
- [ ] Request the same game twice — confirm duplicate is blocked
- [ ] None of the game's owners are RSVP'd — confirm "None of the owners are attending" error
- [ ] The literal owner has NOT RSVP'd, but a member they've linked as a delegate (2.4n) has RSVP'd yes/maybe — confirm the request still succeeds instead of hitting "None of the owners are attending"
- [ ] On an event whose lineup hasn't locked yet, confirm no DM is sent to anyone, and the reply notes "An owner will be asked to bring it once the lineup locks"
- [ ] Force the lineup to lock (4.7), then confirm the assigned owner receives a DM with a "✅ Confirm bringing" button for the requested game (include any owned expansions in the DM text)
- [ ] With 2+ attending owners and no expansion copy-select shown, confirm the DM (once sent, at lock) goes to whichever owner currently has the fewest confirmed brings for that event, not just the first owner alphabetically/by id
- [ ] Request a game on an event whose lineup is **already locked** — confirm the DM goes out immediately (no deferral) since there's no future lock left to wait for

#### Request with expansion copy select
- [ ] Request a game where at least one attending owner has expansions — confirm "Which copy would you like?" select appears
- [ ] Select a specific owner's copy — confirm announcement includes "— bringing: @owner" immediately, but (pre-lock) that owner doesn't receive the DM until the lineup locks
- [ ] Select **Bot decides** — confirm no owner is chosen or announced yet (no "— bringing: @owner" in the reply); once the lineup locks, confirm the bot then assigns the owner with fewest confirmed brings and DMs them

#### Confirming via the DM button
- [ ] Tap "✅ Confirm bringing" in the DM — confirm it behaves the same as `/library bring game:<name>` (message edits to show confirmed, ✅ appears next to the game in the event's request pin)
- [ ] Tap the DM button as an account that no longer owns the requested game — confirm "You can only confirm bringing games you own" reply, and the request is **not** marked confirmed
- [ ] Confirm the same request via `/library bring game:<name>` instead of the DM button — confirm the earlier DM is edited afterward to note "Confirmed via /library bring", with its button removed
- [ ] Tap a "please bring this" DM button for a request that's since been dropped (e.g. the game ended up with zero seated players at lock, 4.7) — confirm a graceful "no longer exists" edit rather than an error or a duplicate confirmation

### 2.4i `/library unrequest`

**What it does:** Cancels your own game requests for an event. Self-only — shows only your own requests. Hosts can remove any request via `/host library unrequest`.

- [ ] Run `/library unrequest` inside an event channel — confirm only your own requests appear in the select menu
- [ ] Select a request and remove it — confirm it disappears from the request pin
- [ ] Run `/library unrequest` with no personal requests — confirm "You haven't requested any games for this event"
- [ ] Run from outside an event channel — confirm event picker appears; selecting an event shows your requests for that event only
- [ ] 👑 Confirm this command still only shows your own requests, even as a Host — **note:** the code gates full visibility on the `Manage Events` permission itself, so a real Host-role account may *also* see every request here rather than just its own. If you observe that, it's a product behavior question (should `/library unrequest` stay self-only even for Hosts?) rather than a test-setup mistake — flag it rather than assuming the test is wrong.

### 2.4j `/library bring`

**What it does:** Shows which of your library games have been requested for upcoming events, or confirms you're bringing a game.

- [ ] Run `/library bring` — confirm only your games that have been requested appear
- [ ] Run `/library bring game:Root` (where Root is requested with your copy preferred) — confirm success message with expansion list
- [ ] Click Confirm — confirm ✅ appears next to the game in the event's request pin
- [ ] Run with a game that hasn't been requested — confirm "That game hasn't been requested" error
- [ ] As a member linked as a delegate (2.4n) of the owner whose copy was requested, run `/library bring` — confirm the owner's requested game appears in your view too, and `/library bring game:X` lets you see expansion availability and confirm bringing it exactly as if it were your own

### 2.4k `/library import`

#### `/library import bgg`

**What it does:** Imports all owned games and expansions from your linked BoardGameGeek collection.

- [ ] Run without a linked BGG account — confirm "You don't have a BoardGameGeek account linked" error
- [ ] Run with a linked account — confirm success message with game/expansion counts
- [ ] Run a second time — confirm all entries show as "already in your library" (no duplicates)

#### `/library import csv`

**What it does:** Bulk-imports games from a CSV file. Available to any server member.

- [ ] Run `/library import csv` with a valid CSV — confirm games are added
- [ ] Run with malformed CSV — confirm appropriate error message
- [ ] Run with a CSV containing duplicate rows for the same game — confirm no duplicate library entries are created

### 2.4l `/library search`

**What it does:** Searches the library with filters for player count, tags, duration, and complexity. If no `tag`/`tag2`/`tag3` or `complexity` option is given, it defaults to your own `/myroles` preferences (2.5) instead of requiring you to type them every time.

- [ ] `/library search players:4` — confirm results include games supporting 4 players, sorted by proximity to 4
- [ ] `/library search players:2,4` (multiple counts) — confirm games matching either count appear
- [ ] `/library search tag:Co-op` — confirm only Co-op tagged games appear
- [ ] `/library search tag:Co-op tag2:Party` — confirm results include games matching EITHER tag (OR logic across tag/tag2/tag3)
- [ ] `/library search tag:Co-op tag2:Party tag3:Strategy` — confirm all three tags are OR'd together
- [ ] `/library search duration:60` — confirm games with play time within ±15 minutes of 60 appear
- [ ] `/library search min_duration:30` — confirm only games with play time ≥ 30 minutes appear
- [ ] `/library search max_duration:60` — confirm only games with play time ≤ 60 minutes appear
- [ ] `/library search min_duration:30 max_duration:60` — confirm only games within that exact range appear
- [ ] `/library search complexity:Light` — confirm only Light games appear
- [ ] Combine filters (e.g. `players`, `tag`, and `complexity` together) — confirm all filters apply together (AND across filter types, OR within tag1/2/3)
- [ ] Set genre/difficulty preferences via `/myroles` (2.5), then run `/library search` with no options at all — confirm it searches using those preferences instead of erroring, and the result description notes "(from your /myroles)"
- [ ] With `/myroles` preferences set, run `/library search tag:Party` (a tag different from your preference) — confirm the explicit tag wins over your preferences, with no "(from your /myroles)" note
- [ ] With no `/myroles` preferences set, run `/library search` with no options at all — confirm error: "Provide at least one valid filter: `players`, `tag`, or `duration` — or set your preferences with `/myroles` to search based on those."
- [ ] Search with valid filters but no matches — confirm "No games matched your filters"

### 2.4m `/library random`

**What it does:** Picks 3 random games from the library, optionally filtered by tags and complexity. If no `tag`/`tag2`/`tag3` or `complexity` option is given, it defaults to your own `/myroles` preferences (2.5) instead of picking from the whole library.

- [ ] `/library random` with no filters and no `/myroles` preferences set — confirm 3 fully random games are shown, with a footer tip to set `/myroles`
- [ ] `/library random tag:Co-op` — confirm all 3 results are Co-op tagged
- [ ] `/library random tag:Co-op tag2:Party` — confirm results match EITHER tag (OR logic across tag/tag2/tag3)
- [ ] `/library random complexity:Light` — confirm all 3 results are Light complexity
- [ ] `/library random tag:Co-op complexity:Heavy` — confirm results match the tag AND the complexity together
- [ ] Set genre/difficulty preferences via `/myroles` (2.5), then run `/library random` with no options at all — confirm the title includes "(from your /myroles)" and results are filtered to those preferences
- [ ] With `/myroles` preferences set, run `/library random complexity:Heavy` (different from your preference) — confirm the explicit complexity wins, with no "(from your /myroles)" note
- [ ] Filter for a tag/complexity combination with no matching games — confirm it falls back to 3 unfiltered random picks with a "No `<filter>` games found — here are 3 random picks instead" title
- [ ] Run multiple times — confirm different results each time

### 2.4n `/library link` / `/library unlink`

**What it does:** `/library link user:@X` grants @X delegate access to your library — they can view your games in their own `/library mine`, and can request/bring them, but this never gives them write access (add/remove/edit/clear) and never gives you access to theirs. It's one-directional: for two people to fully share with each other, each runs `/library link` once naming the other. `/library unlink user:@X` removes the link and can be run by either party.

- [ ] `/library link user:@Bob` (run by Alice) — confirm reply: "<@Bob> can now see your games in their `/library mine`, and can request/confirm bringing them. This only shares *your* library with them — if you'd like the same access to theirs, they'll need to run `/library link user:@you`."
- [ ] As Bob, run `/library mine` (2.4c) — confirm Alice's games now appear, marked `*(shared from <@Alice>)*`
- [ ] As Alice, run `/library mine` — confirm Bob's games do NOT appear — the link is one-directional, and Alice only granted access, she didn't receive any
- [ ] Run `/library link user:@Bob` again as Alice (already linked) — confirm reply: "<@Bob> can already view and manage bringing for your library." and no duplicate link is created
- [ ] `/library link user:@yourself` (target = yourself) — confirm "You can't link your own account to itself."
- [ ] `/library link user:@SomeBot` (target = a bot account) — confirm "You can't link a bot account."
- [ ] `/library unlink user:@Bob` run by Alice (the grantor) — confirm "Library link with <@Bob> removed." and Bob's `/library mine` no longer shows Alice's games
- [ ] Re-link Alice → Bob, then run `/library unlink user:@Alice` as Bob (the delegate, not the original grantor) — confirm the link is still removed even though Bob didn't create it
- [ ] `/library unlink user:@Carol` where no link exists between you and Carol — confirm "You don't have a library link with <@Carol>."
- [ ] With Alice → Bob and Alice → Carol both linked, run `/library unlink user:@Bob` — confirm only the Alice–Bob link is removed; Carol's shared access to Alice's library is unaffected

## 2.5 `/myroles` — Game Preferences

**What it does:** A 2-step interactive flow for members to set their difficulty preference and up to 5 genre tags. Roles are updated on Save.

- [ ] Run `/myroles` — confirm Step 1 (difficulty) embed appears with difficulty buttons
- [ ] Click a difficulty button (e.g. Light) — confirm it highlights and updates the embed
- [ ] Click **Next: Pick Genres →** — confirm Step 2 (genre) embed appears
- [ ] Select up to 5 genre tags — confirm they highlight green
- [ ] Attempt to select a 6th genre — confirm buttons are disabled ("limit reached")
- [ ] Click **Save** — confirm roles are updated in the server
- [ ] Run `/myroles` again after saving — confirm existing roles are pre-selected

## 2.6 `/bgg` — BGG Account Linking

**What it does:** Lets members link their BoardGameGeek username to their Discord account on this server.

### 2.6a `/bgg link`
- [ ] Run `/bgg link username:validuser` — confirm BGG API validates and success embed appears with "Powered by BGG" logo
- [ ] Run `/bgg link username:nonexistentuser` — confirm "We couldn't verify that BoardGameGeek account" message
- [ ] Run with same username already linked — confirm "already linked" message

### 2.6b `/bgg unlink`
- [ ] Run after linking — confirm account is removed
- [ ] Run with no account linked — confirm "You don't have a BGG account linked" message

### 2.6c `/bgg profile`
- [ ] Run after linking — confirm embed shows linked username, BGG profile link, and linked date
- [ ] Run with no account linked — confirm helpful error with hint to use `/bgg link`

## 2.7 `/marketplace` — Community Marketplace (member-level commands)

### 2.7a `/marketplace post sell`

**What it does:** Creates a for-sale listing, optionally enriched with BGG game details and current BGG marketplace price data.

**Prerequisites:** most cases below assume a marketplace channel is already configured via `/admin marketplace config` (3.9m) — the "no channel configured" case further down is intentionally tested without it.

- [ ] Run `/marketplace post sell item:Wingspan offers_allowed:true condition:Very Good` (renamed from `bids_allowed`) — confirm BGG price screen appears (ephemeral) with current marketplace prices and "Powered by BGG" logo
- [ ] Select a price option (use suggested, enter custom, or open to offers) — confirm forum post created with item name, price, a "Negotiable?" field showing "💬 Open to Offers", condition, and "I'm Interested" button
- [ ] Run with `offers_allowed:false` (renamed from `bids_allowed`) — confirm the listing embed's "Negotiable?" field shows "🔒 Firm Price" instead of "💬 Open to Offers", and the forum post now also shows a "⚡ Buy It Now" button alongside "I'm Interested" (see 5.1a for the full Buy It Now flow)
- [ ] Confirm the post-creation confirmation embed (shown right after posting) also has a "Negotiable?" field with the matching value ("💬 Open to Offers" / "🔒 Firm Price") — this field was previously named "Bids" with values "Allowed"/"Firm price"
- [ ] Select "List as open to offers" — confirm listing shows "Open to offers"
- [ ] Run with `notes` — confirm notes appear in the listing embed
- [ ] Confirm BGG thumbnail appears in the embed (if BGG found the item)
- [ ] Confirm "Powered by BGG" logo appears in the forum post embed
- [ ] Run when no marketplace channel is configured — confirm listing is still created, response notes no channel configured
- [ ] Run with an item that has expansions — confirm expansion select step appears; selecting expansions shows combined price estimate
- [ ] Run with an item that IS an expansion (e.g. `Wingspan: European Expansion`) — confirm the expansion-select step is **skipped**; instead a prompt asks whether to include the base game, with "✅ Include `<Base Game>`" and "➡️ Just the Expansion" buttons
- [ ] Choose to include the base game — confirm the price screen title includes "+ Base Game" and combines pricing for both items; the resulting listing embed's title also shows "+ Base Game" and includes an "Includes Base Game" field
- [ ] Choose "Just the Expansion" — confirm the listing posts normally with no base-game bundling; the embed still shows a "Base game on BGG" reference link, marked "(not included)"

#### Custom / non-BGG items
- [ ] Start typing an item name that has no BGG match, then select the "📝 not on BGG / custom item" autocomplete option — confirm no BGG price screen appears and you're instead prompted to add a reference link (**Add Link** / **Skip** buttons)
- [ ] Click **Add Link**, submit a URL in the modal — confirm the listing embed shows a "Reference link" entry pointing to that URL
- [ ] Click **Skip** — confirm the listing posts with no reference link and no BGG thumbnail
- [ ] Click **Add Link** and submit a non-URL string (e.g. plain text) — confirm graceful validation rather than a broken link field

### 2.7b `/marketplace post trade`

**What it does:** Creates a trade listing for an item you want to trade away.

- [ ] Run `/marketplace post trade item:Catan condition:Good looking_for:Wingspan` — confirm trade listing posted to forum with "For Trade" tag, an "Offering" field showing the item name, and a "Looking For" field showing "Wingspan" (the two fields display side by side)
- [ ] Confirm the post-creation confirmation embed ("Trade listing created — Catan") also shows the "Offering" field immediately before the "Looking For" field
- [ ] Run without `looking_for` — confirm listing shows "Open to offers"
- [ ] Confirm "I'm Interested" button appears on the forum post
- [ ] Select the "📝 not on BGG / custom item" autocomplete option — confirm the same Add Link / Skip reference-link flow as `/marketplace post sell` (see 2.7a) applies here too
- [ ] Run with an item that IS an expansion — confirm the same include-base-game prompt from `/marketplace post sell` (see 2.7a) appears before the trade listing is created

### 2.7c `/marketplace price`

**What it does:** Looks up current BGG marketplace prices for an item without creating a listing.

- [ ] Run `/marketplace price item:Wingspan` — confirm ephemeral embed shows price range, median, avg, distribution histogram, and "Powered by BGG" logo
- [ ] Run with an item that has expansions — confirm expansion select step appears; selecting expansions shows per-item breakdown and combined estimate with total listing count
- [ ] Run with an item that IS an expansion — confirm the include-base-game prompt appears instead of an expansion-select step; choosing to include the base game shows a per-item price breakdown including the base game
- [ ] Run with a custom/non-BGG item (type a name not in the catalog) — confirm "not in the BGG catalog" error
- [ ] Confirm no listing is created and nothing is posted to the marketplace channel

### 2.7d `/marketplace conditions`

**What it does:** Shows the condition grading scale used for marketplace listings.

- [ ] Run `/marketplace conditions` — confirm ephemeral embed appears with all five grades: New, Like New, Very Good, Good, Acceptable, each with a description
- [ ] Confirm the embed is only visible to the user who ran the command

### 2.7e `/marketplace browse`

**What it does:** Shows active listings in an ephemeral text list (up to 5 at a time).

- [ ] Run with no listings — confirm "No active listings found"
- [ ] Run with active listings — confirm list shows item name, price/offer, and seller username
- [ ] Run with a listing that has open offers — confirm the list shows an inline "(N offer(s))" annotation next to the price/offer for that listing
- [ ] Run with `type:sell` — confirm only sell listings appear
- [ ] Run with `type:trade` — confirm only trade listings appear
- [ ] Run with more than 5 active listings — confirm "Showing 5 of N. Check the marketplace channel for all listings."

### 2.7f `/marketplace my`

**What it does:** Shows your own listings with their status, offers, and IDs.

- [ ] Run with no listings — confirm "You don't have any listings"
- [ ] Run with listings — confirm all your listings are shown with status, price/offer, an "(N open offer(s))" annotation when offers are open, and listing ID

### 2.7g "I'm Interested" button flow

**What it does:** Buyer clicks button, modal opens, an offer is submitted, seller is notified. Firm-price listings also show a "Buy It Now" button that skips the seller-review step entirely.

**Requires a second account — moved to Part 5.1a.** This flow needs a distinct buyer and seller identity (you can't make an offer on your own listing, and Discord won't let an account DM itself), so it can't be exercised by one tester alone — see Part 5.1a below.

### 2.7h Negotiation — Accept / Deny / Counter

**What it does:** Seller responds to offers with Accept, Deny, or Counter buttons sent via DM (or thread fallback if DMs are disabled).

**Requires a second account — moved to Part 5.1b.** Accept/Deny/Counter is a live exchange between a seller's DM and a buyer's DM, so it needs two people/accounts watching for prompts around the same time — see Part 5.1b below.

### 2.7i Negotiation modes

**What it does:** Controls whether offer negotiation is visible publicly in the forum thread or in a private thread.

**Requires a second account — moved to Part 5.1c.** Verifying what each mode shows means comparing what the buyer's action produces against what the seller sees, which needs both identities — see Part 5.1c below.

### 2.7j `/marketplace close` and `/marketplace reopen`

**What it does:** Seller closes a listing; either party can reopen it if the deal falls through.

- [ ] Run `/marketplace close <id>` as the seller — confirm listing status becomes ⚫ Closed and forum post updates
- [ ] 👑 Run `/marketplace close <id>` as a different user (non-admin) — confirm "You can only close your own listings"
- [ ] Run `/marketplace reopen <id>` as the seller — confirm listing status returns to Active (or Pending if offers exist)
- [ ] Run `/marketplace reopen <id>` as a different user — confirm error

### 2.7k Transaction log

**What it does:** Every marketplace event is appended to `data/marketplace_log.jsonl`.

- [ ] After creating a listing, open `data/marketplace_log.jsonl` — confirm a `listing_created` entry with correct `guildId`, `listingId`, `listingName`, `actorId`, and `timestamp`
- [ ] After an offer is accepted, confirm `bid_accepted` and `listing_sold` entries appear
- [ ] After an offer is denied, confirm `bid_denied` entry appears
- [ ] Confirm no entries are missing for any action in the flow above

### 2.7l Permission boundaries (Host)

- [ ] Confirm a Host CAN use `post sell`, `post trade`, `price`, `conditions`, `browse`, `my`, `close` (own listings), `reopen` (own listings) — same as a regular member
- [ ] 👑 Try `/admin marketplace config` and `/admin marketplace purge` as a Host — confirm "requires Manage Server permission" (Host role alone does not grant this)

### 2.7m Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" **forum post** (not a plain channel message — forum channels pin threads, not messages) in the configured marketplace channel, with buttons for 📦 Sell an Item, 🔄 Propose a Trade, 🔍 Browse Listings, and 📋 My Listings. Created (or refreshed) automatically whenever `/admin marketplace config` (3.9m) sets the channel. Sell/Trade need an item name, which a modal only supports as free text (no autocomplete like the slash command's `item` option) — so the wizard collects the name via modal, then condition via a native select, then (sell only) offers-allowed via buttons, before handing off to the exact same listing-creation flow (BGG lookup, expansion select, price screen) the slash commands use. Trades skip the offers-allowed step since trades are always open to offers, same as `/marketplace post trade`.

**Prerequisites:** a marketplace channel configured via `/admin marketplace config` (3.9m).

- [ ] Configure the marketplace channel — confirm a "🎮 Quick Actions" post appears in the forum, pinned to the top
- [ ] Tap "📦 Sell an Item" — confirm a modal asks for an item name
- [ ] Submit the modal — confirm a condition select appears (New / Like New / Very Good / Good / Acceptable)
- [ ] Select a condition — confirm "✅ Allow Offers" / "🔒 Firm Price" buttons appear
- [ ] Tap either offers button — confirm it proceeds exactly like `/marketplace post sell` would from that point (BGG match on a base game → expansion select; BGG match on an expansion → include-base-game prompt; otherwise → price screen; no BGG match → reference-link prompt)
- [ ] Tap "🔄 Propose a Trade" — confirm a modal asks for an item name
- [ ] Submit the modal and select a condition — confirm it proceeds directly to the listing flow with **no** offers-allowed step, unlike the Sell wizard
- [ ] Tap "🔍 Browse Listings" — confirm it shows the same output as `/marketplace browse` with no type filter (all sell + trade listings)
- [ ] Tap "📋 My Listings" — confirm it shows the same output as `/marketplace my` for the tapping user
- [ ] Start the Sell (or Trade) wizard, then wait or restart the bot before finishing a step — confirm tapping a stale condition/offers button shows a "session has expired" message rather than an error or a crash

## 2.8 `/host` — Host Commands

**What it does:** Provides elevated event and moderation commands to members with the Host role (or Manage Events permission). Non-hosts should not see these commands in the Discord command picker.

### 2.8a `/host event create`

**What it does:** Creates a Discord scheduled event, a text channel, and posts an RSVP embed in the configured announcements channel. If the announcements channel is a **Forum Channel**, the event becomes a forum thread instead of a plain message, tagged "Upcoming" (see 3.9a for eager tag creation).

- [ ] Create an event with required fields only: `/host event create title:Board Game Bash date:August 22 time:7pm` — confirm:
  - Discord scheduled event is created, named `Board Game Bash — <full date>`
  - A channel named `august-22-board-game-bash` appears under "Events" (the default event category name)
  - Channel topic and welcome message both reference "Board Game Bash"
  - Channel topic also ends with "Event ID: `<id>`" — confirm the ID matches the one shown in the RSVP embed footer, so the ID is visible from the event channel itself, not just the announcement post
  - RSVP embed is posted in the announcements channel, titled `Board Game Bash — <full date>`
- [ ] With the announcements channel set to a Forum Channel (3.9a), create an event — confirm a new forum thread is posted with the "Upcoming" tag applied
- [ ] Attempt to create an event without `title` — confirm Discord rejects it as a missing required option
- [ ] Create an event with all fields (end_time, location, link, description) — confirm all appear in the embed
- [ ] Confirm date formats work: `aug 22`, `August 22`, `august 22, 2026`
- [ ] Confirm time formats work: `7pm`, `7:00 PM`, `19:00`
- [ ] Attempt to create an event with a date/time already in the past — confirm the bot handles it gracefully (rejects with a clear error, or accepts per design) rather than silently creating a broken past event

### 2.8b `/host event edit`

**What it does:** Updates an existing game night in place — title, date, time, end_time, location, link, and description are all editable — without cancelling and recreating it. The Discord scheduled event, event channel name/topic, and RSVP embed are all kept in sync.

**Prerequisites:** an event must already exist (created via 2.8a) — grab its ID from the RSVP embed footer or the event channel's topic.

- [ ] Run `/host event edit id:<event-id>` with no other options — confirm "Provide at least one field to update" error
- [ ] Run `/host event edit id:<event-id> location:New Venue` — confirm the RSVP embed updates to show the new location
- [ ] Run `/host event edit id:<event-id> title:New Title` — confirm the event channel is renamed and re-topic'd, the Discord scheduled event's name updates, and the RSVP embed title updates
- [ ] Run `/host event edit id:<event-id> date:<a new date>` with no `end_time` — confirm the event's overall duration is preserved (end time shifts by the same amount as the date/start time)
- [ ] Run `/host event edit id:<event-id> end_time:<a new end time>` — confirm only the end time changes
- [ ] Attempt to edit with an invalid ID — confirm "No event found" error
- [ ] Attempt to edit a cancelled event — confirm "already cancelled and cannot be edited" error
- [ ] Attempt to edit an archived event — confirm "already concluded and cannot be edited" error
- [ ] Attempt to parse an invalid date/time — confirm a clear parse error, matching `/host event create`'s error style

### 2.8c `/host event cancel`

**What it does:** Cancels a game night, deletes the Discord scheduled event, removes the RSVP embed, and cleans up the event channel. If the RSVP was a forum thread, it's tagged "Cancelled" and locked/archived instead of deleted.

- [ ] Cancel an event as the creator: `/host event cancel id:<event-id>` — confirm event is removed
- [ ] Cancel an event as a host (non-creator) — confirm it works
- [ ] With a forum announcements channel, cancel an event — confirm the forum thread is tagged "Cancelled", gets a "this event has been cancelled" message, and is locked/archived
- [ ] Attempt to cancel with an invalid ID — confirm "No event found" error
- [ ] Attempt to cancel an already-cancelled event — confirm "already cancelled" error

### 2.8d `/host event archive`

**What it does:** Manually archives channels for all past events that haven't been archived yet. If the RSVP was a forum thread, it's tagged "Concluded" and locked/archived.

- [ ] Run `/host event archive` with no past events — confirm "No past event channels to archive"
- [ ] Run with a past event — confirm channel moves to "Archive" category and a lock-date message is posted
- [ ] With a forum announcements channel, archive a past event — confirm the forum thread is tagged "Concluded", gets a "this event has concluded" message, and is locked/archived

### 2.8e `/host event privacy`

**What it does:** Opens or restricts a single event's channel, overriding the server-wide `open_channels` default (3.9a) for just that event — e.g. to open up a channel that was created RSVP-only, or lock down one that was created open, without changing the default for future events.

- [ ] With an event created RSVP-only, run `/host event privacy id:<event-id> open:true` — confirm the channel becomes visible to everyone (no longer hidden from `@everyone`)
- [ ] With an event created open, run `/host event privacy id:<event-id> open:false` — confirm the channel is hidden from `@everyone`, and that the event creator plus everyone currently RSVP'd Going/Maybe still has access
- [ ] After closing an open event via `open:false`, have a new member RSVP Going — confirm they gain channel access same as any RSVP-only event (2.2b)
- [ ] Run the same `open:true`/`open:false` value the channel is already set to — confirm a "already open to everyone"/"already RSVP-only" message and no channel changes
- [ ] Attempt on an invalid event ID — confirm "No event found" error
- [ ] Attempt on a cancelled or archived event — confirm the same "already cancelled"/"already concluded" errors as `/host event edit` (2.8b)
- [ ] 👑 Attempt as a non-host — confirm "Only hosts can change an event's channel visibility" error

### 2.8f `/host event greeters`

**What it does:** Sets, views, or removes an event's greeters — up to 2 members who rotate each event. While assigned, a greeter can only join, waitlist, or suggest Light-complexity games (unconfirmed/unknown complexity counts as not-Light and is blocked too), keeping them free to help arriving guests. If there are two greeters, they can never both be seated (or waitlisted) on the same game. Assigning a greeter who's already seated somewhere that violates these rules automatically removes them from that seat/waitlist spot (and the other greeter's seat if they're doubled up), and reports what was removed. `remove:@user` removes just that one greeter (no seat reconciliation needed — lifting the restriction never creates a conflict), leaving any other greeter untouched; `clear:true` removes both at once; running the command with no options shows who's currently set instead of erroring.

- [ ] Run `/host event greeters id:<event-id> greeter1:@Alice` — confirm the reply confirms Alice is now a greeter, restricted to Light games
- [ ] Run `/host event greeters id:<event-id> greeter1:@Alice greeter2:@Bob` — confirm the reply also notes they can't both be seated on the same game
- [ ] Run `/host event greeters id:<event-id> greeter1:@Alice greeter2:@Alice` — confirm a "must be different users" error and nothing changes
- [ ] With Alice and Bob both set as greeters, run `/host event greeters id:<event-id> remove:@Alice` — confirm Alice is removed and can join/suggest any game again, while Bob remains a greeter with the restriction still in effect; reply notes "Remaining greeter: @Bob"
- [ ] With only Alice set as a greeter, run `/host event greeters id:<event-id> remove:@Alice` — confirm the reply says "No greeters remain for this event"
- [ ] Run `/host event greeters id:<event-id> remove:@Carol` when Carol isn't currently a greeter — confirm "isn't currently a greeter" error and nothing changes
- [ ] Run `/host event greeters id:<event-id> clear:true` — confirm greeters are cleared and both members can freely join/suggest any game again
- [ ] Run with no options at all, before any greeters are set — confirm the reply says "No greeters currently set" plus a usage hint (`greeter1`/`remove`/`clear:true`)
- [ ] Run with no options at all, with Alice and Bob already set as greeters — confirm the reply shows "Current greeter(s) for event `<id>`: @Alice and @Bob"
- [ ] Attempt on an invalid event ID — confirm "No event found" error
- [ ] Attempt on a cancelled or archived event — confirm the same "already cancelled"/"already concluded" errors as `/host event edit` (2.8b)
- [ ] 👑 Attempt as a non-host — confirm "Only hosts can set greeters" error
- [ ] With Alice already seated on a Medium/Heavy game, assign her as `greeter1` — confirm she's automatically removed from that game's seats, its posted card updates live, and the reply lists what was removed
- [ ] With Alice already on a Medium/Heavy game's waitlist, assign her as a greeter — confirm she's removed from the waitlist too, with the same live-card update
- [ ] With Alice and Bob both already seated together on the same Light game, assign them as `greeter1`/`greeter2` — confirm Bob (the second-listed) is removed while Alice keeps her seat, and the reply explains why
- [ ] As a greeter, attempt to Join a Medium/Heavy game — confirm "As a greeter for this event, you can only sign up for Light-complexity games..." error and the seat is not taken
- [ ] As a greeter, attempt to Join a game with no confirmed complexity (BGG has no weight data) — confirm the same restriction applies (unknown complexity is treated as not-Light)
- [ ] As a greeter, Join a Light-complexity game — confirm it works normally
- [ ] As a greeter, attempt to `/game suggest` a Medium/Heavy (or unknown-complexity) game — confirm the suggestion is rejected before it's posted, with the same Light-complexity error (suggesting auto-seats you, so it counts as signing up)
- [ ] As a greeter, `/game suggest` a Light-complexity game — confirm it posts normally
- [ ] With two greeters assigned, have the first Join a Light game, then have the second attempt to Join or Waitlist that same game — confirm "Both greeters can't be on the same game..." error
- [ ] With two greeters assigned, confirm each can freely join *different* Light games at the same time
- [ ] Confirm a regular (non-greeter) member is unaffected by any of the above restrictions

### 2.8g `/host game cancel`

**What it does:** Removes any game from the event lineup regardless of who suggested it. If the given title isn't an exact match, falls back to a fuzzy match against the current lineup (e.g. `catan` matches "Settlers of Catan").

- [ ] Remove another user's game: `/host game cancel title:Wingspan` — confirm card is deleted
- [ ] Remove a game using a partial/fuzzy title, e.g. `/host game cancel title:catan` — confirm it's found and removed
- [ ] With two similarly-named games in the lineup, run `/host game cancel` with an ambiguous partial title — confirm the bot asks you to be more specific instead of guessing
- [ ] Attempt to cancel a game not in the lineup (no exact or fuzzy match) — confirm "No game called X found" error

### 2.8h `/host library unrequest`

**What it does:** Shows all game requests for an event (not just the host's own) and allows removing any of them.

- [ ] Run inside an event channel — confirm ALL game requests appear (not just yours)
- [ ] Remove another user's request — confirm it disappears from the request pin
- [ ] Run with no requests — confirm "No games have been requested for this event"
- [ ] Run from outside an event channel — confirm event picker appears; selecting an event shows all requests

## 2.9 `/room` — Private Rooms

### 2.9a `/room create`

**What it does:** Creates a new private text channel visible only to whoever you mention, plus hosts and admins — hidden from everyone else. Posts a message pinging each invited person, and creates the channel under a separate category (default "Private Rooms", configurable via `/admin room config`, 3.9o) so it's never mixed in with event/archive channels. Requires a `date` (when the room auto-closes — see 4.8), unless `persist:true` is set, which creates a room with no expiration at all — see 2.9c to toggle this later. A persistent room's channel name and topic are prefixed with 📌 so hosts/admins can spot it in the channel list without opening it.

**Prerequisites:** none — any server member can run this, not just hosts/admins.

- [ ] Run `/room create people:@Alice @Bob date:August 22` — confirm a new channel is created under the "Private Rooms" category, and the ping message + confirmation both state it expires August 22
- [ ] Run `/room create people:@Alice persist:true` with no `date` — confirm the room is created with no expiration, the channel name and topic are prefixed with 📌, and the ping message + confirmation both say it persists until closed
- [ ] Confirm a normal (non-persistent) room's channel name and topic are **not** prefixed with 📌
- [ ] Attempt to create a room with neither `date` nor `persist:true` — confirm a clear "Provide a `date`..." error and no channel is created
- [ ] Run with an unparseable `date` (e.g. "whenever") — confirm a clear parse error and no channel is created
- [ ] Run with a `date` already in the past — confirm "That date has already passed" error and no channel is created
- [ ] Confirm the channel is hidden from `@everyone` — a member who wasn't mentioned and has no Host/Admin role cannot see it
- [ ] Confirm you (the creator), the mentioned people, and any Host/Admin role member can all see the channel
- [ ] Confirm a message posts in the new channel `@`mentioning each invited person
- [ ] Run with a `name` option — confirm the channel is named accordingly
- [ ] Run without a `name` option — confirm a reasonable auto-generated name is used instead
- [ ] Run with `people` containing no valid `@`mentions (e.g. plain text) — confirm a clear error and no channel is created
- [ ] Mention yourself along with others — confirm you aren't invited twice/duplicated
- [ ] Mention someone who has since left the server — confirm they're skipped with a note in the reply, and the room is still created for the remaining valid people
- [ ] Mention only people who've all left the server — confirm a clear "couldn't find any" error and no channel is created
- [ ] Create a second room in the same server — confirm it reuses the existing "Private Rooms" category rather than creating a duplicate

### 2.9b `/room close`

**What it does:** Deletes a private room. Must be run inside the room's own channel. The room's creator or any host/admin can close it — nobody else.

- [ ] Run inside a room you created — confirm the channel is deleted
- [ ] Run inside a room someone else created, as a Host or Admin — confirm it works
- [ ] Run inside a room someone else created, as a regular member with no elevated role — confirm "Only the room's creator or a host/admin can close this room" error, and the channel is **not** deleted
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 2.9c `/room persist`

**What it does:** Turns a private room's auto-expiration on (`enabled:true`) or off (`enabled:false`, requires a new `date`). Must be run inside the room's own channel. The room's creator or any host/admin can toggle it — nobody else. See 4.8 for how auto-expiration works. The channel's 📌 name/topic prefix updates immediately to match.

- [ ] Run `/room persist enabled:true` inside a room that has a `date` — confirm the reply says the room will no longer auto-expire, the channel name and topic gain the 📌 prefix, and it survives past its original expiration date
- [ ] Run `/room persist enabled:false` inside a persistent room, with a `date` — confirm the reply confirms the new expiration, the channel name and topic lose the 📌 prefix, and the room auto-closes on that date (4.8)
- [ ] Run `/room persist enabled:false` inside a persistent room, with **no** `date` — confirm a clear "Provide a `date`..." error and the room remains persistent
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can change this room's expiration" error, and nothing changes
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 2.9d `/room invite`

**What it does:** Adds more people to an existing private room, granting them channel access and updating the stored room record. Must be run inside the room's own channel. The room's creator or any host/admin can invite — nobody else.

- [ ] Run `/room invite people:@Carol` inside a room — confirm Carol gains access to the channel, is pinged in a message, and the confirmation reply says she was added
- [ ] Confirm the newly added person now shows up if the room is later inspected (e.g. they count toward "already in this room" on a repeat invite)
- [ ] Mention someone who's already the creator or an existing invitee — confirm a clear "isn't already in this room" error and no channel/reply changes
- [ ] Mention someone who has since left the server — confirm they're skipped with a note in the reply, and any other valid mentions are still added
- [ ] Mention only people who've all left the server — confirm a clear "couldn't find any" error
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can invite people to this room" error, and nobody is added
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 2.9e `/room kick`

**What it does:** Removes someone from an existing private room, revoking their channel access and updating the stored room record. Must be run inside the room's own channel. The room's creator or any host/admin can kick — nobody else. The room's creator cannot be kicked (close the room instead).

- [ ] Run `/room kick user:@Carol` inside a room Carol was invited to — confirm Carol loses access to the channel, a message announces her removal, and the confirmation reply says she was removed
- [ ] Attempt to kick the room's creator — confirm "You can't remove the room's creator..." error and nothing changes
- [ ] Attempt to kick someone who was never invited to this room — confirm a clear "hasn't been individually invited" error and nothing changes
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can remove people from this room" error, and nobody is removed
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 2.9f Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" message posted automatically the moment a room is created, alongside the existing plain-text welcome message — buttons for 🎲 Suggest a Game, ➕ Invite, 👢 Kick, 📌 Toggle Auto-Expire, and 🔒 Close Room. The Suggest a Game button is the exact same one used in event channels (same modal, same underlying flow) — it just resolves this room instead of an event when tapped here. Invite/Kick use Discord's native member-picker (a dropdown of server members) instead of typing mentions or a user option, and Close Room adds a Yes/Cancel confirmation step that the slash command itself doesn't have, since a misplaced tap is easier than a mistyped command for something this irreversible. Every button enforces the same "room creator or host/admin" permission check as its slash-command equivalent.

- [ ] Create a room — confirm the "🎮 Quick Actions" message appears, pinned, alongside the separate plain-text welcome message
- [ ] Tap "🎲 Suggest a Game" — confirm the same modal/flow as the event-channel hub, correctly suggesting into this room
- [ ] Tap "➕ Invite" as the room's creator — confirm a member-picker appears; selecting one or more people grants them channel access and adds them to the room, identical to `/room invite`
- [ ] Tap "➕ Invite" as a member with no elevated role who isn't the room's creator — confirm the same permission error `/room invite` gives
- [ ] Tap "👢 Kick" with nobody individually invited yet — confirm "Nobody has been individually invited to this room..." instead of an empty/broken picker
- [ ] Tap "👢 Kick" and select someone invited to the room — confirm they lose access, identical to `/room kick`
- [ ] Tap "👢 Kick" and select the room's creator — confirm "You can't remove the room's creator..." same as the command
- [ ] Tap "📌 Toggle Auto-Expire" on a room with a set expiration date — confirm it immediately becomes persistent (no modal), same as `/room persist enabled:true`
- [ ] Tap "📌 Toggle Auto-Expire" on a persistent room — confirm a modal asks for a new expiration date, and submitting it sets the date and turns persistence back off, same as `/room persist enabled:false date:...`
- [ ] Tap "🔒 Close Room" — confirm a "this cannot be undone" Yes/Cancel prompt appears rather than closing immediately
- [ ] Tap "Cancel" on that prompt — confirm the room stays open
- [ ] Tap "Yes, close this room" — confirm the room is closed and its channel deleted, identical to `/room close`

## 2.10 General Chat — Quick Actions Hub

### 2.10a Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" message in a designated, already-populated chat channel (e.g. #general) — set via `/admin general config` (3.9q). Unlike the event/room/marketplace hubs, this one isn't tied to any single command; it's a standalone panel of the most-used member actions that don't otherwise have a home: ✅ RSVP to Next Event, 📚 Browse Library, 📋 My Games, 🎲 Random Game, and 🙋 Request a Game to Bring. The Request button is the *exact same* `/library request` hub button used in event channels — since that flow already falls back to the soonest upcoming event when there's no specific event-channel context, it works correctly from any channel with no changes.

**Prerequisites:** a channel configured via `/admin general config` (3.9q).

- [ ] Configure the general hub channel — confirm the "🎮 Quick Actions" message appears there, pinned
- [ ] Tap "✅ RSVP to Next Event" with an upcoming event — confirm an ephemeral reply with a link button that jumps directly to that event's announcement post
- [ ] Tap "✅ RSVP to Next Event" with no upcoming events — confirm "There's no upcoming event to RSVP to yet" instead of an error
- [ ] With 2+ upcoming events, tap "✅ RSVP to Next Event" — confirm it jumps to the **soonest** one, not just the first one created
- [ ] Tap "📚 Browse Library" — confirm the same output as `/library list` (2.4a)
- [ ] Tap "📋 My Games" — confirm the same output as `/library mine` (2.4b), listing only your own (and shared-with-you) games
- [ ] Tap "🎲 Random Game" — confirm the same output as running `/library random` with no options, including the personalization fallback to your `/myroles` (2.5) preferences if set
- [ ] Tap "🙋 Request a Game to Bring" — confirm the same modal/flow as the event-channel hub (1.3h), targeting the soonest upcoming event since there's no specific event channel here

---

# Part 3 — Admin Tests (Admin role / Manage Guild permission)

Admins retain full Regular Member and Host access, so this part fully repeats Parts 1 and 2's checks (run them against an Admin-role account) before adding the Admin-only commands in 3.9.

## 3.1 `/help`

**What it does:** Displays an ephemeral embed listing all available commands, tier-filtered to the invoking user's permissions.

- [ ] Run `/help` as an admin — confirm all three sections appear: user commands, **🎪 /host**, and **🔧 /admin**, now split across **🔧 /admin — Server & library configuration** and **🔧 /admin — Welcome, marketplace & rooms** (regression check: this used to be one field that silently exceeded Discord's 1024-character field limit and made `/help` fail with no response at all for every admin)
- [ ] Confirm `/game cancel` description says "Remove your own game suggestion"
- [ ] Confirm `/library clear` description says "Remove all your own games at once"
- [ ] Confirm the response is ephemeral
- [ ] Confirm `/admin` commands **are visible** in the Discord slash command picker, along with `/host`
- [ ] Confirm `/admin library syncall` is listed in the Admin section

## 3.2 `/event` — Event Viewing

### 3.2a `/event list`

**What it does:** Lists all upcoming (non-cancelled, non-archived) game nights with IDs, dates, times, and RSVP counts.

- [ ] With at least one active event — confirm it shows the event with its ID and details
- [ ] With no active events — confirm it shows "No upcoming game nights scheduled"
- [ ] Confirm the response is ephemeral

### 3.2b RSVP Buttons

**What it does:** Members click Going / Maybe / Can't Go on the RSVP embed to update their RSVP status. In RSVP-only mode, Going/Maybe grants access to the event channel.

**Prerequisites:** an event must already exist with its RSVP embed posted (created via `/host event create`, 2.8a) — see the global Prerequisites section above.

- [ ] Click **Going** — confirm:
  - RSVP count updates in the embed
  - Member gains access to the event channel (if RSVP-only mode)
- [ ] Click **Maybe** — confirm similar behavior to Going
- [ ] Click **Can't Go** — confirm:
  - RSVP count updates
  - Member loses access to the event channel (if RSVP-only mode)
- [ ] Toggle between statuses (Going → Maybe → Can't Go → Going) — confirm counts stay accurate
- [ ] Remove "Interested" from the Discord scheduled event directly — confirm bot marks user as Can't Go

## 3.3 `/game` — Game Suggestions

All `/game` commands should be used inside an active event channel unless otherwise noted.

### 3.3a `/game suggest`

**What it does:** Suggests a game for the event (or, from inside a private room, for that room — see below). Checks the group library first (exact match → partial match → BGG search). Prompts to add tags if not already tagged.

#### From a private room
- [ ] Run `/game suggest title:Wingspan` from inside a `/room`-created private room channel (1.8a) — confirm it posts the game card directly in the room, with no event picker
- [ ] Suggest a library game whose owner is a member of the room but not attending any event — confirm it's allowed (attendance is checked against room membership, not event RSVPs)
- [ ] Suggest a library game whose owner is **not** a member of the room — confirm "None of the owners are attending" error, same wording as the event case
- [ ] Confirm Join/Leave buttons on a room-suggested game card work the same as in an event channel
- [ ] Confirm suggesting in a room does **not** create a request-pin or lineup-pin entry — "bring to a future event" tracking doesn't apply to an ad-hoc room

#### From a library game (exact match)
- [ ] Add a game to your library first (`/library add game:Wingspan`)
- [ ] RSVP Going to the event
- [ ] Run `/game suggest title:Wingspan` — confirm game card appears in the event channel with owner listed
- [ ] Confirm the suggester is automatically shown as a seated player on the game card
- [ ] Confirm the tag picker appears if the game has no tags set
- [ ] Try suggesting the same game again — confirm "already in the lineup" duplicate error

#### From a library game (partial match)
- [ ] Run `/game suggest title:Wing` (partial) — confirm a dropdown appears with library matches and a "Search BGG instead" option
- [ ] Select a match from the dropdown — confirm the game is added

#### Game owner not attending
- [ ] Attempt to suggest a game where the owner has not RSVP'd — confirm "None of the owners are attending" error

#### From BGG search
- [ ] Run `/game suggest title:Ticket to Ride` — confirm BGG results dropdown appears
- [ ] Confirm results are sorted newest publish year first
- [ ] Select a result — confirm game card is posted with BGG-sourced data
- [ ] If the BGG game has no tags — confirm tag picker appears
- [ ] Select tags, click Save — confirm tags appear on the game card and prompt to confirm bringing the game
- [ ] Click Skip on tag picker — confirm bring prompt appears
- [ ] Search a generic term with more than 24 BGG matches — confirm **← Previous** / **Page X of Y** / **Next →** buttons appear below the dropdown, with Previous disabled on page 1
- [ ] Click **Next →** — confirm the dropdown updates to the next page of results (newest-first order continues across pages) and **Previous** becomes enabled
- [ ] Navigate to the last page — confirm **Next →** is disabled
- [ ] Search a term with 24 or fewer matches — confirm no pagination buttons appear (dropdown only)

#### With expansions
- [ ] Run `/game suggest title:Wingspan with_expansions:True`
- [ ] Select the game from BGG results — confirm expansion selection dropdown appears
- [ ] Select expansions and confirm — confirm game card shows expansions
- [ ] If a game has no expansions — confirm it posts directly without the expansion step

#### Manual entry
- [ ] Select "None of these — enter details manually" from the BGG dropdown
- [ ] Fill in the modal (title, players, duration) and submit — confirm game card is posted
- [ ] Leave optional fields blank — confirm it posts without them

#### From outside an event channel
- [ ] Run `/game suggest title:Catan` from a non-event channel — confirm an event picker dropdown appears
- [ ] Select an event — confirm the suggest flow continues normally
- [ ] With multiple upcoming events, run `/game suggest` for a title that has no library match, select an event from the picker — confirm the BGG search dropdown appears next (regression: the event picker used to lose track of the typed title if it wasn't resolved as part of the same interaction, making it look like nothing happened after picking an event)
- [ ] Same as above but with a title that **is** an exact library match — confirm the game card posts directly (with the owner listed) right after picking the event, no extra step
- [ ] Restart/redeploy the bot between running `/game suggest` (before picking an event) and selecting an event from the picker — confirm the picker still resolves the original title correctly afterward (the title/expansion choice now travels with the dropdown itself rather than living in the bot process's memory)
- [ ] Select an event from the picker for a lineup that has already locked (4.7) — confirm the same "lineup is locked" message you'd get from suggesting directly in that event's channel

### 3.3b `/game list`

**What it does:** Lists all games suggested for the current event channel with player count, duration, and seats. Must be used inside an event channel.

- [ ] Run `/game list` in an event channel with games — confirm all games appear with stats and jump links
- [ ] Run `/game list` in a channel with no games — confirm "No games have been added yet"
- [ ] Run `/game list` in a non-event channel (e.g. general) — confirm helpful error: "Use `/game list` inside an event channel…"

### 3.3c `/game cancel`

**What it does:** Removes a game suggestion from the lineup. The person who suggested the game, that event's host, or an admin can remove it via this command; hosts/admins can also remove any game via `/host game cancel`. If the given title isn't an exact match, falls back to a fuzzy match against the current lineup (e.g. `catan` matches "Settlers of Catan").

- [ ] Remove your own game suggestion: `/game cancel title:Wingspan` — confirm card is deleted
- [ ] Remove your own game suggestion using a partial/fuzzy title, e.g. `/game cancel title:catan` when "Settlers of Catan" is in the lineup — confirm it's found and removed
- [ ] With two similarly-named games in the lineup (e.g. "Wingspan" and "Wingspan: Asia"), run `/game cancel title:wing` — confirm the bot asks you to be more specific instead of guessing, and neither game is removed
- [ ] As an admin, remove a game suggested by someone else via `/game cancel` (not `/host game cancel`) — confirm it succeeds instead of the suggester-only error
- [ ] Attempt to cancel a game not in the lineup (no exact or fuzzy match) — confirm "No game called X found" error

### 3.3d Game Card Buttons — Join / Leave

**What it does:** Players click Join to take a seat in a game, Leave to vacate it.

- [ ] Click **Join** on a game card — confirm name appears in the seats list and count updates
- [ ] Click **Join** again on the same game — confirm "You're already in this game" error
- [ ] Click **Leave** — confirm name is removed and count updates
- [ ] Click **Leave** without being in the game — confirm "You're not in this game" error
- [ ] Fill all seats to the max player count — confirm the Join button becomes the Waitlist button

### 3.3e Game Card Buttons — Waitlist

**What it does:** When a game is full, players join a waitlist. If the waitlist reaches the minimum player count, the request pin is updated to reflect 2 copies needed — and if that game has a `/library request` (1.4h) outstanding, the bot automatically asks one more attending owner (load-balanced, excluding anyone already asked/confirmed/declined) to bring a second copy, the same "🎲 ... ✅ Confirm bringing / ❌ Can't bring it" DM as the initial request. If the waitlist later drops back below the threshold, that extra ask is retracted — its DM is edited to say it's no longer needed and its buttons removed — rather than left outstanding. When a seated player leaves and the game is full, the first waitlisted player is automatically promoted into the freed seat and removed from the waitlist (they get a DM if their DMs are open).

- [ ] Fill a game to max players, then click **Join Waitlist** — confirm added to waitlist section
- [ ] Click **Join Waitlist** when already on waitlist — confirm "You're already on the waitlist" error
- [ ] Click **Join Waitlist** when a seat is still available — confirm "There's still an open seat" error
- [ ] Add enough players to the waitlist to reach the minimum player count, with a `/library request` (1.4h) already outstanding for that game and 2+ attending owners — confirm the request pin updates to show "X/2 copies confirmed" and a second attending owner receives a "please bring a copy" DM
- [ ] Do the same with only 1 owner attending — confirm the pin still shows the updated copy count, but no second DM is sent (no eligible second owner to ask)
- [ ] Click **Leave Waitlist** — confirm removed from waitlist
- [ ] Dropping below min players on waitlist, with a second owner's ask still outstanding (unconfirmed) — confirm the pin reverts to 1 copy needed and that owner's DM is edited to say it's no longer needed, with its buttons removed
- [ ] Dropping below min players after the second owner already confirmed — confirm the pin reverts to 1 copy needed but the existing confirmation is left alone (a harmless extra confirmed copy), not retracted
- [ ] With a full game and at least one person on the waitlist, have a seated player click **Leave** — confirm the first waitlisted person is moved into the freed seat, removed from the waitlist list, and (if their DMs are open) receives a DM saying a seat opened up
- [ ] Do the same when promoting the waitlist below the minimum player count drops it back below 2 groups — confirm the request pin reverts to 1 copy needed

### 3.3f Bring Confirm / Cancel

**What it does:** After adding a game via BGG or manual entry, the bot asks if you're bringing the game. Confirming adds it to your library.

- [ ] After suggesting a BGG game, click **Yes, I'll bring it** — confirm game is added to your library (check with `/library mine`)
- [ ] Click **No** — confirm the game is still in the lineup but not added to your library

## 3.4 `/library` — Game Library

### 3.4a `/library add`

**What it does:** Adds a game you own to the shared library. Follows a priority order: checks your own library, then the group library, then the BGG catalog. When BGG finds an exact match, shows a confirm prompt before adding so the user can verify it's the right game.

#### Basic add — already owned
- [ ] `/library add game:Wingspan` when you already own it — confirm "already in your library" duplicate message
- [ ] Case-insensitive: `/library add game:wingspan` when you own "Wingspan" — same duplicate message
- [ ] `/library add game:Wingspan` when a member who's linked you as a delegate (3.4n) owns it, and you don't — confirm `**Wingspan** is already in your library (shared from <@owner>'s library).` rather than the "adding your copy?" prompt

#### Others already own the game
- [ ] When another user owns the game (exact name match), confirm "already in the group library — adding your copy?" prompt with **Yes, add my copy** and **Cancel** buttons
- [ ] Click **Yes, add my copy** — confirm game is added
- [ ] Confirm this "adding your copy?" prompt still appears for a stranger's matching entry when there's no library link between you — linking only changes the behavior for linked delegates (see 3.4n)

#### Partial match in group library
- [ ] `/library add game:wing` when "Wingspan" is in the group library — confirm a "similar games in the group library" select menu appears
- [ ] Select a match — confirm "adding your copy?" flow
- [ ] Select "None of these — search BGG" — confirm BGG catalog search continues
- [ ] `/library add game:wing` where the only "Wingspan" entry in the group library is owned by a member who's linked you as a delegate (3.4n) — select it from the dropdown — confirm "already in your library (shared from @owner's library)" instead of the "adding your copy?" flow

#### BGG exact match (confirm prompt)
- [ ] `/library add game:Wingspan` on an empty library — confirm a "Found **Wingspan** on BGG — is that the game?" confirm prompt appears
- [ ] Click **Yes** — confirm game is added with BGG details; no "add details" modal appears
- [ ] Click **No** — confirm BGG is dismissed and the "add details" modal appears for custom entry

#### BGG multiple matches (select UI)
- [ ] `/library add game:arkham` — confirm a "which did you mean?" select menu appears
- [ ] Select a game from the dropdown — confirm the BGG confirm prompt appears
- [ ] Confirm **Yes** — confirm game is added with BGG details
- [ ] Search a very generic term with many BGG matches — confirm the dropdown is capped at Discord's 25-option select menu limit rather than erroring

#### No matches anywhere — custom game
- [ ] `/library add game:My Custom Game` with nothing matching anywhere — confirm game is added immediately and the "add details" modal appears

### 3.4b `/library remove`

**What it does:** Removes one of your games from the library. Supports fuzzy/partial name matching.

- [ ] `/library remove game:Catan` (exact match) — confirm "Removed **Catan** from your library"
- [ ] `/library remove game:cat` (partial match for "Catan") — confirm a select menu of matching games appears
- [ ] Select a game from the partial match menu — confirm it is removed
- [ ] Attempt to remove a game not in your library — confirm "not found" error

### 3.4c `/library mine`

**What it does:** Lists all base games you've added to the library, plus any linked delegates' games. Expansions imported via `/library import bgg` are excluded. Paginates with Previous/Next buttons when large (same pattern as `/library list`, 3.4d) — a member linked to several delegates' libraries can easily exceed a single embed field's capacity.

- [ ] Run `/library mine` with games added — confirm all your base games are listed
- [ ] If you have imported BGG expansions — confirm they do NOT appear in `/library mine`
- [ ] Run `/library mine` with no games — confirm "You haven't added any games" message
- [ ] With another member's library linked to you as a delegate (3.4n), run `/library mine` — confirm their games appear alongside your own, each marked `*(shared from <@ownerId>)*`
- [ ] With enough games (yours plus any linked delegates') to exceed one page:
  - [ ] Confirm **← Previous** and **Next →** buttons appear, with a "Page X of Y" indicator between them
  - [ ] **← Previous** is disabled on the first page
  - [ ] Click **Next →** — confirm page 2 is shown with different games
  - [ ] **Next →** is disabled on the last page
  - [ ] Confirm no error occurs regardless of how large the combined list is (regression: this previously crashed once the list exceeded Discord's embed description limit)

### 3.4d `/library list`

**What it does:** Shows all base games in the library grouped by game with all owners listed. Paginates with Previous/Next buttons when large.

- [ ] Run `/library list` — confirm all library base games appear with owners
- [ ] Confirm games with complexity set show 🟢/🟡/🔴 icons before the name
- [ ] Games without complexity data should appear without an icon
- [ ] Run with an empty library — confirm "No games in the library yet"
- [ ] With a large library:
  - [ ] Confirm **← Previous** and **Next →** buttons appear
  - [ ] **← Previous** is disabled on the first page
  - [ ] Click **Next →** — confirm page 2 is shown
  - [ ] **Next →** is disabled on the last page

### 3.4e `/library view`

**What it does:** Shows full details for a specific game. Lazily enriches from BGG on first view (tags, expansions, weight, complexity, best player count, how-to-play video, thumbnail).

- [ ] `/library view game:Root` — confirm embed shows player range, best player count, play time, complexity with role mention, tags, Resources field (how-to-play link + BGG files link), thumbnail in top-right, and Powered by BGG logo
- [ ] View a game with no BGG data — confirm enrichment runs and data appears
- [ ] View a game where you are an owner — confirm edit footer hint appears
- [ ] View a game that doesn't exist — confirm "not found" message

### 3.4f `/library edit`

**What it does:** Lets you update the details of a game you own (player count, play time, tags, expansions, and complexity). Every field in the modal is pre-filled with its current value, so deleting a field's text and saving clears that field rather than leaving the old value in place.

- [ ] `/library edit game:Wingspan` — confirm the edit modal appears, pre-filled with the game's current values
- [ ] Update player range, save — confirm updated values appear in `/library view`
- [ ] Set an expansion you own (e.g. `Prelude`), save, then re-open `/library edit` and clear the Expansions field entirely — confirm `/library view` no longer lists any expansions
- [ ] Clear the player range, play time, tags, and complexity fields (leave every field blank), save — confirm `/library view` shows none of those values set, rather than the previous ones
- [ ] Set Complexity to `Medium` — confirm 🟡 icon appears in `/library list`
- [ ] Set Complexity to `light` (lowercase) — confirm it is accepted and normalized to `Light`
- [ ] Set Complexity to an invalid value (e.g. `Extreme`) — confirm a warning is shown and the previous value is kept
- [ ] Attempt to edit a game you don't own — confirm permission error

### 3.4g `/library clear`

**What it does:** Removes all of your own games from the library via this self-only command. Use `/admin library clear` to clear another user's library.

- [ ] Run `/library clear` — confirm all your own games are removed (verify with `/library mine`)
- [ ] Run with no games in your library — confirm "You have no games in the library to remove"
- [ ] Confirm this command still only removes your own games, even as an Admin (use `/admin library clear` to target someone else)

### 3.4h `/library request`

**What it does:** Requests a specific game be brought to an event. No "please bring this" DM goes out yet — asking is deferred until the event's lineup locks (4.7), so the bot can pick fairly from each owner's *final* confirmed-brings count instead of an early, mostly-arbitrary snapshot. At lock, the request is asked of the owner the copy-select assigned it to (an explicit pick), or — when no copy-select is shown, or **Bot decides** was selected — whichever attending owner currently has the fewest confirmed brings for that event, with "🎲 ... ✅ Confirm bringing" and "❌ Can't bring it" buttons. Confirming behaves the same as `/library bring game:<name>`; declining cascades the same DM to the next eligible attending owner (see "Declining via the DM button" below). If the waitlist for a suggested game grows enough to need a second copy (1.3e/2.3e/3.3e), that just updates how many owners get asked at lock — it doesn't trigger an ask itself. A request made *after* the lineup is already locked has no future lock to wait for, so it's asked immediately instead.

**Prerequisites:** an active event must exist, and the game being requested must already be in the library, owned by someone who has RSVP'd (see 1.4a/2.4a/3.4a to add a game first).

#### Basic request (no expansions in library)
- [ ] `/library request game:Catan` from a non-event channel — confirm request targets the soonest upcoming event
- [ ] `/library request game:Catan` from inside a specific event channel — confirm request targets that event
- [ ] Request the same game twice — confirm duplicate is blocked
- [ ] None of the game's owners are RSVP'd — confirm "None of the owners are attending" error
- [ ] The literal owner has NOT RSVP'd, but a member they've linked as a delegate (3.4n) has RSVP'd yes/maybe — confirm the request still succeeds instead of hitting "None of the owners are attending"
- [ ] On an event whose lineup hasn't locked yet, confirm no DM is sent to anyone, and the reply notes "An owner will be asked to bring it once the lineup locks"
- [ ] Force the lineup to lock (4.7), then confirm the assigned owner receives a DM with a "✅ Confirm bringing" button for the requested game (include any owned expansions in the DM text)
- [ ] With 2+ attending owners and no expansion copy-select shown, confirm the DM (once sent, at lock) goes to whichever owner currently has the fewest confirmed brings for that event, not just the first owner alphabetically/by id
- [ ] Request a game on an event whose lineup is **already locked** — confirm the DM goes out immediately (no deferral) since there's no future lock left to wait for

#### Request with expansion copy select
- [ ] Request a game where at least one attending owner has expansions — confirm "Which copy would you like?" select appears
- [ ] Select a specific owner's copy — confirm announcement includes "— bringing: @owner" immediately, but (pre-lock) that owner doesn't receive the DM until the lineup locks
- [ ] Select **Bot decides** — confirm no owner is chosen or announced yet (no "— bringing: @owner" in the reply); once the lineup locks, confirm the bot then assigns the owner with fewest confirmed brings and DMs them

#### Confirming via the DM button
- [ ] Tap "✅ Confirm bringing" in the DM — confirm it behaves the same as `/library bring game:<name>` (message edits to show confirmed, ✅ appears next to the game in the event's request pin)
- [ ] Tap the DM button as an account that no longer owns the requested game — confirm "You can only confirm bringing games you own" reply, and the request is **not** marked confirmed
- [ ] Confirm the same request via `/library bring game:<name>` instead of the DM button — confirm the earlier DM is edited afterward to note "Confirmed via /library bring", with its button removed
- [ ] Tap a "please bring this" DM button for a request that's since been dropped (e.g. the game ended up with zero seated players at lock, 4.7) — confirm a graceful "no longer exists" edit rather than an error or a duplicate confirmation

### 3.4i `/library unrequest`

**What it does:** Cancels your own game requests for an event. Self-only — shows only your own requests. Hosts/admins can remove any request via `/host library unrequest`.

- [ ] Run `/library unrequest` inside an event channel — confirm only your own requests appear in the select menu
- [ ] Select a request and remove it — confirm it disappears from the request pin
- [ ] Run `/library unrequest` with no personal requests — confirm "You haven't requested any games for this event"
- [ ] Run from outside an event channel — confirm event picker appears; selecting an event shows your requests for that event only

### 3.4j `/library bring`

**What it does:** Shows which of your library games have been requested for upcoming events, or confirms you're bringing a game.

- [ ] Run `/library bring` — confirm only your games that have been requested appear
- [ ] Run `/library bring game:Root` (where Root is requested with your copy preferred) — confirm success message with expansion list
- [ ] Click Confirm — confirm ✅ appears next to the game in the event's request pin
- [ ] Run with a game that hasn't been requested — confirm "That game hasn't been requested" error
- [ ] As a member linked as a delegate (3.4n) of the owner whose copy was requested, run `/library bring` — confirm the owner's requested game appears in your view too, and `/library bring game:X` lets you see expansion availability and confirm bringing it exactly as if it were your own

### 3.4k `/library import`

#### `/library import bgg`

**What it does:** Imports all owned games and expansions from your linked BoardGameGeek collection.

- [ ] Run without a linked BGG account — confirm "You don't have a BoardGameGeek account linked" error
- [ ] Run with a linked account — confirm success message with game/expansion counts
- [ ] Run a second time — confirm all entries show as "already in your library" (no duplicates)

#### `/library import csv`

**What it does:** Bulk-imports games from a CSV file. Available to any server member.

- [ ] Run `/library import csv` with a valid CSV — confirm games are added
- [ ] Run with malformed CSV — confirm appropriate error message
- [ ] Run with a CSV containing duplicate rows for the same game — confirm no duplicate library entries are created

### 3.4l `/library search`

**What it does:** Searches the library with filters for player count, tags, duration, and complexity. If no `tag`/`tag2`/`tag3` or `complexity` option is given, it defaults to your own `/myroles` preferences (3.5) instead of requiring you to type them every time.

- [ ] `/library search players:4` — confirm results include games supporting 4 players, sorted by proximity to 4
- [ ] `/library search players:2,4` (multiple counts) — confirm games matching either count appear
- [ ] `/library search tag:Co-op` — confirm only Co-op tagged games appear
- [ ] `/library search tag:Co-op tag2:Party` — confirm results include games matching EITHER tag (OR logic across tag/tag2/tag3)
- [ ] `/library search tag:Co-op tag2:Party tag3:Strategy` — confirm all three tags are OR'd together
- [ ] `/library search duration:60` — confirm games with play time within ±15 minutes of 60 appear
- [ ] `/library search min_duration:30` — confirm only games with play time ≥ 30 minutes appear
- [ ] `/library search max_duration:60` — confirm only games with play time ≤ 60 minutes appear
- [ ] `/library search min_duration:30 max_duration:60` — confirm only games within that exact range appear
- [ ] `/library search complexity:Light` — confirm only Light games appear
- [ ] Combine filters (e.g. `players`, `tag`, and `complexity` together) — confirm all filters apply together (AND across filter types, OR within tag1/2/3)
- [ ] Set genre/difficulty preferences via `/myroles` (3.5), then run `/library search` with no options at all — confirm it searches using those preferences instead of erroring, and the result description notes "(from your /myroles)"
- [ ] With `/myroles` preferences set, run `/library search tag:Party` (a tag different from your preference) — confirm the explicit tag wins over your preferences, with no "(from your /myroles)" note
- [ ] With no `/myroles` preferences set, run `/library search` with no options at all — confirm error: "Provide at least one valid filter: `players`, `tag`, or `duration` — or set your preferences with `/myroles` to search based on those."
- [ ] Search with valid filters but no matches — confirm "No games matched your filters"

### 3.4m `/library random`

**What it does:** Picks 3 random games from the library, optionally filtered by tags and complexity. If no `tag`/`tag2`/`tag3` or `complexity` option is given, it defaults to your own `/myroles` preferences (3.5) instead of picking from the whole library.

- [ ] `/library random` with no filters and no `/myroles` preferences set — confirm 3 fully random games are shown, with a footer tip to set `/myroles`
- [ ] `/library random tag:Co-op` — confirm all 3 results are Co-op tagged
- [ ] `/library random tag:Co-op tag2:Party` — confirm results match EITHER tag (OR logic across tag/tag2/tag3)
- [ ] `/library random complexity:Light` — confirm all 3 results are Light complexity
- [ ] `/library random tag:Co-op complexity:Heavy` — confirm results match the tag AND the complexity together
- [ ] Set genre/difficulty preferences via `/myroles` (3.5), then run `/library random` with no options at all — confirm the title includes "(from your /myroles)" and results are filtered to those preferences
- [ ] With `/myroles` preferences set, run `/library random complexity:Heavy` (different from your preference) — confirm the explicit complexity wins, with no "(from your /myroles)" note
- [ ] Filter for a tag/complexity combination with no matching games — confirm it falls back to 3 unfiltered random picks with a "No `<filter>` games found — here are 3 random picks instead" title
- [ ] Run multiple times — confirm different results each time

### 3.4n `/library link` / `/library unlink`

**What it does:** `/library link user:@X` grants @X delegate access to your library — they can view your games in their own `/library mine`, and can request/bring them, but this never gives them write access (add/remove/edit/clear) and never gives you access to theirs. It's one-directional: for two people to fully share with each other, each runs `/library link` once naming the other. `/library unlink user:@X` removes the link and can be run by either party.

- [ ] `/library link user:@Bob` (run by Alice) — confirm reply: "<@Bob> can now see your games in their `/library mine`, and can request/confirm bringing them. This only shares *your* library with them — if you'd like the same access to theirs, they'll need to run `/library link user:@you`."
- [ ] As Bob, run `/library mine` (3.4c) — confirm Alice's games now appear, marked `*(shared from <@Alice>)*`
- [ ] As Alice, run `/library mine` — confirm Bob's games do NOT appear — the link is one-directional, and Alice only granted access, she didn't receive any
- [ ] Run `/library link user:@Bob` again as Alice (already linked) — confirm reply: "<@Bob> can already view and manage bringing for your library." and no duplicate link is created
- [ ] `/library link user:@yourself` (target = yourself) — confirm "You can't link your own account to itself."
- [ ] `/library link user:@SomeBot` (target = a bot account) — confirm "You can't link a bot account."
- [ ] `/library unlink user:@Bob` run by Alice (the grantor) — confirm "Library link with <@Bob> removed." and Bob's `/library mine` no longer shows Alice's games
- [ ] Re-link Alice → Bob, then run `/library unlink user:@Alice` as Bob (the delegate, not the original grantor) — confirm the link is still removed even though Bob didn't create it
- [ ] `/library unlink user:@Carol` where no link exists between you and Carol — confirm "You don't have a library link with <@Carol>."
- [ ] With Alice → Bob and Alice → Carol both linked, run `/library unlink user:@Bob` — confirm only the Alice–Bob link is removed; Carol's shared access to Alice's library is unaffected

## 3.5 `/myroles` — Game Preferences

**What it does:** A 2-step interactive flow for members to set their difficulty preference and up to 5 genre tags. Roles are updated on Save.

- [ ] Run `/myroles` — confirm Step 1 (difficulty) embed appears with difficulty buttons
- [ ] Click a difficulty button (e.g. Light) — confirm it highlights and updates the embed
- [ ] Click **Next: Pick Genres →** — confirm Step 2 (genre) embed appears
- [ ] Select up to 5 genre tags — confirm they highlight green
- [ ] Attempt to select a 6th genre — confirm buttons are disabled ("limit reached")
- [ ] Click **Save** — confirm roles are updated in the server
- [ ] Run `/myroles` again after saving — confirm existing roles are pre-selected

## 3.6 `/bgg` — BGG Account Linking

**What it does:** Lets members link their BoardGameGeek username to their Discord account on this server.

### 3.6a `/bgg link`
- [ ] Run `/bgg link username:validuser` — confirm BGG API validates and success embed appears with "Powered by BGG" logo
- [ ] Run `/bgg link username:nonexistentuser` — confirm "We couldn't verify that BoardGameGeek account" message
- [ ] Run with same username already linked — confirm "already linked" message

### 3.6b `/bgg unlink`
- [ ] Run after linking — confirm account is removed
- [ ] Run with no account linked — confirm "You don't have a BGG account linked" message

### 3.6c `/bgg profile`
- [ ] Run after linking — confirm embed shows linked username, BGG profile link, and linked date
- [ ] Run with no account linked — confirm helpful error with hint to use `/bgg link`

## 3.7 `/marketplace` — Community Marketplace (member-level commands)

### 3.7a `/marketplace post sell`

**What it does:** Creates a for-sale listing, optionally enriched with BGG game details and current BGG marketplace price data.

**Prerequisites:** most cases below assume a marketplace channel is already configured via `/admin marketplace config` (3.9m) — the "no channel configured" case further down is intentionally tested without it.

- [ ] Run `/marketplace post sell item:Wingspan offers_allowed:true condition:Very Good` (renamed from `bids_allowed`) — confirm BGG price screen appears (ephemeral) with current marketplace prices and "Powered by BGG" logo
- [ ] Select a price option (use suggested, enter custom, or open to offers) — confirm forum post created with item name, price, a "Negotiable?" field showing "💬 Open to Offers", condition, and "I'm Interested" button
- [ ] Run with `offers_allowed:false` (renamed from `bids_allowed`) — confirm the listing embed's "Negotiable?" field shows "🔒 Firm Price" instead of "💬 Open to Offers", and the forum post now also shows a "⚡ Buy It Now" button alongside "I'm Interested" (see 5.1a for the full Buy It Now flow)
- [ ] Confirm the post-creation confirmation embed (shown right after posting) also has a "Negotiable?" field with the matching value ("💬 Open to Offers" / "🔒 Firm Price") — this field was previously named "Bids" with values "Allowed"/"Firm price"
- [ ] Select "List as open to offers" — confirm listing shows "Open to offers"
- [ ] Run with `notes` — confirm notes appear in the listing embed
- [ ] Confirm BGG thumbnail appears in the embed (if BGG found the item)
- [ ] Confirm "Powered by BGG" logo appears in the forum post embed
- [ ] Run when no marketplace channel is configured — confirm listing is still created, response notes no channel configured
- [ ] Run with an item that has expansions — confirm expansion select step appears; selecting expansions shows combined price estimate
- [ ] Run with an item that IS an expansion (e.g. `Wingspan: European Expansion`) — confirm the expansion-select step is **skipped**; instead a prompt asks whether to include the base game, with "✅ Include `<Base Game>`" and "➡️ Just the Expansion" buttons
- [ ] Choose to include the base game — confirm the price screen title includes "+ Base Game" and combines pricing for both items; the resulting listing embed's title also shows "+ Base Game" and includes an "Includes Base Game" field
- [ ] Choose "Just the Expansion" — confirm the listing posts normally with no base-game bundling; the embed still shows a "Base game on BGG" reference link, marked "(not included)"

#### Custom / non-BGG items
- [ ] Start typing an item name that has no BGG match, then select the "📝 not on BGG / custom item" autocomplete option — confirm no BGG price screen appears and you're instead prompted to add a reference link (**Add Link** / **Skip** buttons)
- [ ] Click **Add Link**, submit a URL in the modal — confirm the listing embed shows a "Reference link" entry pointing to that URL
- [ ] Click **Skip** — confirm the listing posts with no reference link and no BGG thumbnail
- [ ] Click **Add Link** and submit a non-URL string (e.g. plain text) — confirm graceful validation rather than a broken link field

### 3.7b `/marketplace post trade`

**What it does:** Creates a trade listing for an item you want to trade away.

- [ ] Run `/marketplace post trade item:Catan condition:Good looking_for:Wingspan` — confirm trade listing posted to forum with "For Trade" tag, an "Offering" field showing the item name, and a "Looking For" field showing "Wingspan" (the two fields display side by side)
- [ ] Confirm the post-creation confirmation embed ("Trade listing created — Catan") also shows the "Offering" field immediately before the "Looking For" field
- [ ] Run without `looking_for` — confirm listing shows "Open to offers"
- [ ] Confirm "I'm Interested" button appears on the forum post
- [ ] Select the "📝 not on BGG / custom item" autocomplete option — confirm the same Add Link / Skip reference-link flow as `/marketplace post sell` (see 3.7a) applies here too
- [ ] Run with an item that IS an expansion — confirm the same include-base-game prompt from `/marketplace post sell` (see 3.7a) appears before the trade listing is created

### 3.7c `/marketplace price`

**What it does:** Looks up current BGG marketplace prices for an item without creating a listing.

- [ ] Run `/marketplace price item:Wingspan` — confirm ephemeral embed shows price range, median, avg, distribution histogram, and "Powered by BGG" logo
- [ ] Run with an item that has expansions — confirm expansion select step appears; selecting expansions shows per-item breakdown and combined estimate with total listing count
- [ ] Run with an item that IS an expansion — confirm the include-base-game prompt appears instead of an expansion-select step; choosing to include the base game shows a per-item price breakdown including the base game
- [ ] Run with a custom/non-BGG item (type a name not in the catalog) — confirm "not in the BGG catalog" error
- [ ] Confirm no listing is created and nothing is posted to the marketplace channel

### 3.7d `/marketplace conditions`

**What it does:** Shows the condition grading scale used for marketplace listings.

- [ ] Run `/marketplace conditions` — confirm ephemeral embed appears with all five grades: New, Like New, Very Good, Good, Acceptable, each with a description
- [ ] Confirm the embed is only visible to the user who ran the command

### 3.7e `/marketplace browse`

**What it does:** Shows active listings in an ephemeral text list (up to 5 at a time).

- [ ] Run with no listings — confirm "No active listings found"
- [ ] Run with active listings — confirm list shows item name, price/offer, and seller username
- [ ] Run with a listing that has open offers — confirm the list shows an inline "(N offer(s))" annotation next to the price/offer for that listing
- [ ] Run with `type:sell` — confirm only sell listings appear
- [ ] Run with `type:trade` — confirm only trade listings appear
- [ ] Run with more than 5 active listings — confirm "Showing 5 of N. Check the marketplace channel for all listings."

### 3.7f `/marketplace my`

**What it does:** Shows your own listings with their status, offers, and IDs.

- [ ] Run with no listings — confirm "You don't have any listings"
- [ ] Run with listings — confirm all your listings are shown with status, price/offer, an "(N open offer(s))" annotation when offers are open, and listing ID

### 3.7g "I'm Interested" button flow

**What it does:** Buyer clicks button, modal opens, an offer is submitted, seller is notified. Firm-price listings also show a "Buy It Now" button that skips the seller-review step entirely.

**Requires a second account — moved to Part 5.1a.** This flow needs a distinct buyer and seller identity (you can't make an offer on your own listing, and Discord won't let an account DM itself), so it can't be exercised by one tester alone — see Part 5.1a below.

### 3.7h Negotiation — Accept / Deny / Counter

**What it does:** Seller responds to offers with Accept, Deny, or Counter buttons sent via DM (or thread fallback if DMs are disabled).

**Requires a second account — moved to Part 5.1b.** Accept/Deny/Counter is a live exchange between a seller's DM and a buyer's DM, so it needs two people/accounts watching for prompts around the same time — see Part 5.1b below.

### 3.7i Negotiation modes

**What it does:** Controls whether offer negotiation is visible publicly in the forum thread or in a private thread.

**Requires a second account — moved to Part 5.1c.** Verifying what each mode shows means comparing what the buyer's action produces against what the seller sees, which needs both identities — see Part 5.1c below.

### 3.7j `/marketplace close` and `/marketplace reopen`

**What it does:** Seller closes a listing; either party can reopen it if the deal falls through. Admins can additionally close any user's listing.

- [ ] Run `/marketplace close <id>` as the seller — confirm listing status becomes ⚫ Closed and forum post updates
- [ ] Run `/marketplace close <id>` on **another user's** listing as an Admin — confirm it succeeds (Admins bypass the ownership check)
- [ ] Run `/marketplace reopen <id>` as the seller — confirm listing status returns to Active (or Pending if offers exist)

### 3.7k Transaction log

**What it does:** Every marketplace event is appended to `data/marketplace_log.jsonl`.

- [ ] After creating a listing, open `data/marketplace_log.jsonl` — confirm a `listing_created` entry with correct `guildId`, `listingId`, `listingName`, `actorId`, and `timestamp`
- [ ] After an offer is accepted, confirm `bid_accepted` and `listing_sold` entries appear
- [ ] After an offer is denied, confirm `bid_denied` entry appears
- [ ] Confirm no entries are missing for any action in the flow above

## 3.8 `/host` — Host Commands

**What it does:** Provides elevated event and moderation commands, also available to Admins since Admin implies Host-level access.

### 3.8a `/host event create`

**What it does:** Creates a Discord scheduled event, a text channel, and posts an RSVP embed in the configured announcements channel. If the announcements channel is a **Forum Channel**, the event becomes a forum thread instead of a plain message, tagged "Upcoming" (see 3.9a for eager tag creation).

- [ ] Create an event with required fields only: `/host event create title:Board Game Bash date:August 22 time:7pm` — confirm:
  - Discord scheduled event is created, named `Board Game Bash — <full date>`
  - A channel named `august-22-board-game-bash` appears under "Events" (the default event category name)
  - Channel topic and welcome message both reference "Board Game Bash"
  - Channel topic also ends with "Event ID: `<id>`" — confirm the ID matches the one shown in the RSVP embed footer, so the ID is visible from the event channel itself, not just the announcement post
  - RSVP embed is posted in the announcements channel, titled `Board Game Bash — <full date>`
- [ ] With the announcements channel set to a Forum Channel (3.9a), create an event — confirm a new forum thread is posted with the "Upcoming" tag applied
- [ ] Attempt to create an event without `title` — confirm Discord rejects it as a missing required option
- [ ] Create an event with all fields (end_time, location, link, description) — confirm all appear in the embed
- [ ] Confirm date formats work: `aug 22`, `August 22`, `august 22, 2026`
- [ ] Confirm time formats work: `7pm`, `7:00 PM`, `19:00`
- [ ] Attempt to create an event with a date/time already in the past — confirm the bot handles it gracefully (rejects with a clear error, or accepts per design) rather than silently creating a broken past event

### 3.8b `/host event edit`

**What it does:** Updates an existing game night in place — title, date, time, end_time, location, link, and description are all editable — without cancelling and recreating it. The Discord scheduled event, event channel name/topic, and RSVP embed are all kept in sync.

**Prerequisites:** an event must already exist (created via 3.8a) — grab its ID from the RSVP embed footer or the event channel's topic.

- [ ] Run `/host event edit id:<event-id>` with no other options — confirm "Provide at least one field to update" error
- [ ] Run `/host event edit id:<event-id> location:New Venue` — confirm the RSVP embed updates to show the new location
- [ ] Run `/host event edit id:<event-id> title:New Title` — confirm the event channel is renamed and re-topic'd, the Discord scheduled event's name updates, and the RSVP embed title updates
- [ ] Run `/host event edit id:<event-id> date:<a new date>` with no `end_time` — confirm the event's overall duration is preserved (end time shifts by the same amount as the date/start time)
- [ ] Run `/host event edit id:<event-id> end_time:<a new end time>` — confirm only the end time changes
- [ ] Attempt to edit with an invalid ID — confirm "No event found" error
- [ ] Attempt to edit a cancelled event — confirm "already cancelled and cannot be edited" error
- [ ] Attempt to edit an archived event — confirm "already concluded and cannot be edited" error
- [ ] Attempt to parse an invalid date/time — confirm a clear parse error, matching `/host event create`'s error style

### 3.8c `/host event cancel`

**What it does:** Cancels a game night, deletes the Discord scheduled event, removes the RSVP embed, and cleans up the event channel. If the RSVP was a forum thread, it's tagged "Cancelled" and locked/archived instead of deleted.

- [ ] Cancel an event as the creator: `/host event cancel id:<event-id>` — confirm event is removed
- [ ] Cancel an event created by someone else — confirm it works (Admin can cancel any event)
- [ ] With a forum announcements channel, cancel an event — confirm the forum thread is tagged "Cancelled", gets a "this event has been cancelled" message, and is locked/archived
- [ ] Attempt to cancel with an invalid ID — confirm "No event found" error
- [ ] Attempt to cancel an already-cancelled event — confirm "already cancelled" error

### 3.8d `/host event archive`

**What it does:** Manually archives channels for all past events that haven't been archived yet. If the RSVP was a forum thread, it's tagged "Concluded" and locked/archived.

- [ ] Run `/host event archive` with no past events — confirm "No past event channels to archive"
- [ ] Run with a past event — confirm channel moves to "Archive" category and a lock-date message is posted
- [ ] With a forum announcements channel, archive a past event — confirm the forum thread is tagged "Concluded", gets a "this event has concluded" message, and is locked/archived

### 3.8e `/host event privacy`

**What it does:** Opens or restricts a single event's channel, overriding the server-wide `open_channels` default (3.9a) for just that event — e.g. to open up a channel that was created RSVP-only, or lock down one that was created open, without changing the default for future events.

- [ ] With an event created RSVP-only, run `/host event privacy id:<event-id> open:true` — confirm the channel becomes visible to everyone (no longer hidden from `@everyone`)
- [ ] With an event created open, run `/host event privacy id:<event-id> open:false` — confirm the channel is hidden from `@everyone`, and that the event creator plus everyone currently RSVP'd Going/Maybe still has access
- [ ] After closing an open event via `open:false`, have a new member RSVP Going — confirm they gain channel access same as any RSVP-only event (2.2b)
- [ ] Run the same `open:true`/`open:false` value the channel is already set to — confirm a "already open to everyone"/"already RSVP-only" message and no channel changes
- [ ] Attempt on an invalid event ID — confirm "No event found" error
- [ ] Attempt on a cancelled or archived event — confirm the same "already cancelled"/"already concluded" errors as `/host event edit` (3.8b)
- [ ] 👑 Attempt as a non-host — confirm "Only hosts can change an event's channel visibility" error

### 3.8f `/host event greeters`

**What it does:** Sets, views, or removes an event's greeters — up to 2 members who rotate each event. While assigned, a greeter can only join, waitlist, or suggest Light-complexity games (unconfirmed/unknown complexity counts as not-Light and is blocked too), keeping them free to help arriving guests. If there are two greeters, they can never both be seated (or waitlisted) on the same game. Assigning a greeter who's already seated somewhere that violates these rules automatically removes them from that seat/waitlist spot (and the other greeter's seat if they're doubled up), and reports what was removed. `remove:@user` removes just that one greeter, leaving any other in place; `clear:true` removes both; no options shows who's currently set.

See 2.8f for the full checklist — this Admin-tier pass just confirms Admins retain the same access Hosts have:

- [ ] Run `/host event greeters id:<event-id> greeter1:@Alice greeter2:@Bob` as an Admin — confirm it works the same as for a Host
- [ ] As a greeter, confirm the Join/Waitlist/`/game suggest` restrictions from 2.8f still apply regardless of who assigned the greeter role

### 3.8g `/host game cancel`

**What it does:** Removes any game from the event lineup regardless of who suggested it. If the given title isn't an exact match, falls back to a fuzzy match against the current lineup (e.g. `catan` matches "Settlers of Catan").

- [ ] Remove another user's game: `/host game cancel title:Wingspan` — confirm card is deleted
- [ ] Remove a game using a partial/fuzzy title, e.g. `/host game cancel title:catan` — confirm it's found and removed
- [ ] With two similarly-named games in the lineup, run `/host game cancel` with an ambiguous partial title — confirm the bot asks you to be more specific instead of guessing
- [ ] Attempt to cancel a game not in the lineup (no exact or fuzzy match) — confirm "No game called X found" error

### 3.8h `/host library unrequest`

**What it does:** Shows all game requests for an event (not just the caller's own) and allows removing any of them.

- [ ] Run inside an event channel — confirm ALL game requests appear (not just yours)
- [ ] Remove another user's request — confirm it disappears from the request pin
- [ ] Run with no requests — confirm "No games have been requested for this event"
- [ ] Run from outside an event channel — confirm event picker appears; selecting an event shows all requests

## 3.9 `/admin` — Admin Commands

**What it does:** Provides server configuration commands to members with the Admin role (or Manage Guild permission). Non-admins should not see these commands in the Discord command picker.

- [ ] 👑 Confirm `/admin` commands are **not visible** in the command picker for regular members and hosts (cross-check using those accounts)
- [ ] Confirm `/admin` commands **are visible** for members with the Admin role

### 3.9a `/admin event config`

**What it does:** Sets server-wide defaults used when hosts create new events.

- [ ] Run `/admin event config` with no options — confirm it shows current defaults
- [ ] Set a default location: `/admin event config location:Library Room 1` — confirm it saves
- [ ] Set a default start time: `/admin event config time:7:00 PM` — confirm it saves
- [ ] Set an announcements channel: `/admin event config announcements:#announcements` — confirm it saves
- [ ] Set the announcements channel to a **Forum Channel** — confirm it saves and the forum channel's tag list is eagerly populated with "Upcoming", "Cancelled", and "Concluded" tags (check the forum channel's tag settings in Discord) before any event is created
- [ ] Set open channels to true/false — confirm it saves and new events respect the setting
- [ ] Set event category and archive category — confirm new events and archives use the correct category
- [ ] Set `archive_retention_days:14` — confirm it saves and the config summary shows "14 days"
- [ ] Set `archive_retention_days:3` (below the 7-day minimum) — confirm it is floored to 7 days
- [ ] Set `archive_retention_days:0` — confirm the config summary shows "Never auto-delete"
- [ ] Run `/admin event config` on a server that has never touched this setting — confirm the config summary shows "48h before event" (the default — lineup locking is on by default, not opt-in)
- [ ] Set `lock_hours_before_event:24` — confirm the config summary shows "24h before event"
- [ ] Set `lock_hours_before_event:0` — confirm the config summary shows "Disabled" (this is how to opt out, since 0 is no longer the default)
- [ ] Set `table_count:2` — confirm it saves and the config summary reflects it (see 4.7 for the scheduler behavior this feeds — note this is now a *floor*, the actual lock-time table count can be higher based on RSVPs)
- [ ] Set `light_buffer_minutes`, `medium_buffer_minutes`, `heavy_buffer_minutes` — confirm all three save independently and appear in the config summary
- [ ] Set `heavy_game_break_minutes:15` — confirm it saves and the config summary reflects it (see 4.7 for the scheduler behavior this feeds); set to `0` — confirm the config summary shows "Disabled"
- [ ] Set `max_game_repeats:1` — confirm it saves and the config summary shows "1x" (see 4.7)
- [ ] Set `post_bgstats_links:true` — confirm the config summary shows "Enabled" (see 4.7 for the behavior this feeds); set back to `false` — confirm it shows "Disabled" (the default)
- [ ] Run `/admin event config` with no options on a server that's never set a timezone — confirm the config summary shows "Timezone: UTC ⚠️ *not configured...*" with a nudge to set a real IANA timezone
- [ ] Set `timezone:America/New_York` — confirm it saves and the config summary shows "Timezone: America/New_York"
- [ ] Set an invalid value, e.g. `timezone:Not/A_Zone` — confirm a clear ephemeral error naming the bad value and suggesting the IANA format (e.g. `America/New_York`), and that the config is **not** changed
- [ ] With `timezone` set to a non-UTC zone (e.g. `America/New_York`), create an event (2.8a) with a date/time — confirm the RSVP embed's Date/Time and the native Discord scheduled event ("Interested" tab) show the **same** time to you as the viewer (regression: previously the announcement text was formatted in the host server's own local timezone rather than the configured one, so it could silently disagree with the native event depending on where the bot process happened to be running)
- [ ] Confirm the RSVP embed's Date/Time fields render as Discord's own auto-localizing timestamp (hover/click behavior, or compare against a teammate in a different timezone if available) rather than fixed text

### 3.9b `/admin library clear`

**What it does:** Clears all library entries for a specified server member. Admin-only — use for moderation or cleanup.

- [ ] Run `/admin library clear user:@SomeMember` — confirm all their games are removed
- [ ] Run for a user with no library entries — confirm appropriate message

### 3.9c `/admin library sync`

**What it does:** Force re-fetches a game's data from BoardGameGeek, overwriting cached BGG fields (thumbnail, how-to-play video, expansions, best player count).

**Prerequisites:** the library must already contain a game with a BGG ID (added via BGG search rather than manual entry — see 3.4a) for the success case.

- [ ] Run `/admin library sync game:Wingspan` — confirm updated embed shows with "✅ synced from BoardGameGeek" message
- [ ] Run with a game name that doesn't exist in the library — confirm "not found" error with partial match suggestions
- [ ] Run for a game with no BGG ID — confirm "no BGG ID — nothing to sync" error

### 3.9d `/admin library syncall`

**What it does:** Re-syncs every game in the library from BoardGameGeek in one pass (slow, rate-limited), batching up to 20 BGG IDs per request. Admin-only. `force:true` (default, or omitted) overwrites existing data on every game with a BGG ID. `force:false` only fetches and fills in games that are missing at least one BGG-sourced field (tags, expansions, best player count, complexity, how-to-play video, or thumbnail) — a non-destructive "enrich" pass that leaves already-enriched games untouched and doesn't re-query BGG for them.

**Prerequisites:** the library should contain a small mix of games with and without a BGG ID, so both the "refreshed" and "skipped" counts can be verified in one run.

- [ ] Run `/admin library syncall` (no `force` option) with a small library — confirm all games with a BGG ID are refreshed and a summary count is shown, including overwriting a game that already had different manually-set data
- [ ] Run `/admin library syncall force:False` — confirm only games missing BGG data are queried/updated, and an already fully-enriched game's existing data is left unchanged
- [ ] Run `/admin library syncall force:False` again immediately after — confirm the reply says nothing is missing BGG data and no BGG request is made
- [ ] Confirm games with no BGG ID are skipped and counted separately (not treated as failures)
- [ ] Run with an empty library — confirm an appropriate "nothing to sync" message
- [ ] Confirm the command does not time out or double-reply on a larger library (should defer/edit the reply while syncing)

### 3.9e `/admin tags add`

**What it does:** Creates a new game genre or difficulty tag and its corresponding Discord role.

- [ ] `/admin tags add name:Puzzle` — confirm Discord role is created and tag is saved
- [ ] `/admin tags add name:Puzzle color:Red` — confirm role is created with the selected color (use autocomplete)
- [ ] `/admin tags add name:Hard type:Difficulty` — confirm role is created with difficulty type
- [ ] Add a tag with a duplicate name — confirm "already exists" error

### 3.9f `/admin tags remove`

**What it does:** Untracks a game tag and deletes its Discord role — but only if the bot created that role. Tags that were linked to a pre-existing role via `/admin tags sync` (not created by the bot) are untracked without deleting the underlying Discord role.

- [ ] `/admin tags remove name:Puzzle` (bot-created role) — confirm Discord role is deleted, tag is removed, and the reply says "Tag **Puzzle** removed."
- [ ] Remove a tag that was linked from a pre-existing role (see 3.9h) — confirm the Discord role is **not** deleted, the tag is untracked, and the reply explains the role was left in place
- [ ] Attempt to remove a non-existent tag — confirm "No tag named X found. Use `/admin tags list`" error

### 3.9g `/admin tags list`

**What it does:** Lists all current game genre and difficulty tags.

- [ ] Run `/admin tags list` — confirm all tags appear grouped by Difficulty and Genre
- [ ] Run with no tags set up — confirm "No game tags set up yet"

### 3.9h `/admin tags sync`

**What it does:** Ensures a Discord role exists for every built-in game tag and difficulty level. If a role with the same name (case-insensitive) already exists on the server, it is linked/reused instead of creating a duplicate; only tags with no matching role get a newly created one.

- [ ] Run `/admin tags sync` on a fresh server with no matching roles — confirm all built-in genre tags and difficulty roles (Light, Medium, Heavy) are created, and the summary reports "X roles created"
- [ ] Manually create a Discord role with the exact name of one of the built-in tags (e.g. "Party") *before* running sync — confirm sync links to that existing role instead of creating a duplicate, and the summary reports "1 existing role linked"
- [ ] Run sync again after a full sync — confirm "already synced" for all and no duplicates or re-creation
- [ ] Confirm no two Discord roles end up with the same tag name after running sync repeatedly

### 3.9i `/admin tags clear`

**What it does:** Untracks all game tags. Discord roles that the bot created are deleted; roles that were linked from a pre-existing role (via sync) are left in place and only untracked.

- [ ] Run `/admin tags clear` with only bot-created tags — confirm all tag roles are deleted from Discord and the tag list is cleared
- [ ] Run `/admin tags clear` when at least one tag was linked from a pre-existing role (see 3.9h) — confirm that role is **not** deleted from Discord, the reply reports it as "untracked but left in place", and bot-created roles are still deleted normally
- [ ] Run with no tags set up — confirm "No game tags to remove"
- [ ] Confirm the action suggests using `/admin tags sync` to recreate/relink them

### 3.9j `/admin welcome config`

**What it does:** Sets the welcome channel, rules channel, Facebook group URL, and BGG group URL for the automatic welcome message.

- [ ] Run with no options — confirm current config is displayed
- [ ] Set channel: `/admin welcome config channel:#welcome`
- [ ] Set rules channel: `/admin welcome config rules_channel:#rules`
- [ ] Set Facebook URL: `/admin welcome config facebook_url:https://facebook.com/groups/...`
- [ ] Set BGG URL: `/admin welcome config bgg_url:https://boardgamegeek.com/guild/...`
- [ ] Confirm all four values persist after setting them

### 3.9k `/admin welcome test`

**What it does:** Sends the welcome message to yourself as a preview.

- [ ] Run `/admin welcome test` — confirm welcome message appears in the welcome channel and a DM is sent
- [ ] With a BGG group URL configured (3.9j), confirm the welcome embed includes a "🎲 BoardGameGeek" field linking to it
- [ ] With no BGG group URL configured, confirm the welcome embed omits the BoardGameGeek field entirely

### 3.9l `/admin welcome greet`

**What it does:** Manually sends the welcome message to a specific server member.

- [ ] `/admin welcome greet member:@SomeUser` — confirm welcome message is sent to that user's DMs and posted in the welcome channel

### 3.9m `/admin marketplace config`

**What it does:** Configures the marketplace channel — either a Forum channel or a Text channel, both supported side by side per server — and the negotiation mode.

- [ ] Run `/admin marketplace config` with no options — confirm current config is displayed (channel and mode)
- [ ] Run `/admin marketplace config channel:#marketplace-forum negotiation_mode:Public` pointing at a **Forum channel** — confirm settings saved, echoed back, and "Forum tags created/verified and Quick Actions hub posted" shown
- [ ] Try setting a voice channel (or another unsupported type) — confirm error: "must be a Forum Channel or a Text Channel"
- [ ] Run `/admin marketplace config negotiation_mode:Private` — confirm mode changes to private
- [ ] After setting a forum channel, confirm the six tags (`For Sale`, `For Trade`, `Active`, `Pending`, `Sold`, `Closed`) are visible in the channel's tag list
- [ ] After setting a forum channel, also confirm a pinned "🎮 Quick Actions" post appears (1.7m/2.7m) — created alongside the tags, not requiring a listing to be posted first
- [ ] Re-run `/admin marketplace config channel:...` pointing at the same forum channel again — confirm the existing "🎮 Quick Actions" post is refreshed in place rather than a second one being created

#### Text-channel mode (comparison checklist)

Text channels have no forum tags and no thread is created for a listing — each listing is a single plain message (embed + button) in the channel. Status/type visibility is provided by a pinned "🛒 Marketplace Listings" index message instead, grouped by For Sale / For Trade and linking to each listing message, refreshed automatically whenever a listing is created, closed, reopened, or sold. Follow-up activity that would post into a forum thread (new-offer notifications, DM-disabled fallback buttons, sold/closed announcements) is instead posted as a **reply** to the listing message.

- [ ] Run `/admin marketplace config channel:#marketplace-text` pointing at a **Text channel** — confirm it's accepted (no "must be a Forum Channel" error) and the reply shows "Quick Actions hub and listing index posted"
- [ ] Confirm a pinned "🎮 Quick Actions" **message** (not a thread) appears in the text channel, with the same Sell/Trade/Browse/My Listings buttons as the forum hub
- [ ] Confirm a pinned "🛒 Marketplace Listings" message appears, initially reading "No active listings right now"
- [ ] Post a sell listing (via `/marketplace post sell` or the hub's "📦 Sell an Item" button) — confirm it posts as a single plain message in the text channel (embed + "I'm Interested"/"Buy It Now" button, no thread created), and the pinned listing index updates to include it under "🏷️ For Sale" with a working link
- [ ] Post a trade listing — confirm it appears under "🔄 For Trade" in the pinned index
- [ ] With negotiation mode set to Public, submit an offer on a text-mode listing — confirm the "new offer" notification appears as a **reply** to the listing message (not a new top-level message, no thread), and the seller still gets DM action buttons
- [ ] Temporarily disable DMs from server members, submit an offer on a text-mode listing — confirm the DM-fallback response buttons are posted as a reply to the listing message
- [ ] Close, then reopen, a text-mode listing — confirm the button is removed/restored on the listing message on each transition (no lock/archive, since there's no thread), and the pinned index drops/re-adds the listing accordingly
- [ ] Sell a text-mode listing via Buy It Now or Accept Offer — confirm the pinned index removes it, the listing message's button is removed, and a "sold" reply is posted to the listing message
- [ ] Reconfigure the marketplace channel from Text back to Forum (or vice versa) — confirm the previously-configured mode's pinned messages/posts are left untouched (not deleted) and the newly configured mode's hub/tags or hub/index are set up fresh

### 3.9n `/admin marketplace purge`

**What it does:** Admin bulk-deletes listings by status, with an optional user filter. Any thread or message backing a purged listing is deleted too (forum post thread, or the plain listing message in text-channel mode), so purged listings don't linger as posts in the marketplace channel; in text-channel mode the pinned listing index is also refreshed to drop purged listings.

- [ ] 👑 Run as non-admin — confirm "requires Manage Server permission"
- [ ] Run as admin with no options — confirm sold + closed listings deleted, active/pending remain; reply shows `(filter: sold_closed)`
- [ ] Run with `user:@member` and no status — confirm ALL of that member's listings are purged (default becomes `all` when user is specified); reply shows `(filter: all)`
- [ ] Run with `status:Active` — confirm only active listings are removed, pending/sold/closed remain
- [ ] Run with `status:Active + Pending` — confirm active and pending listings are removed
- [ ] Run with `status:All` — confirm every listing is removed
- [ ] Confirm purge count and filter label are reported accurately in the reply
- [ ] For a purged listing that has a forum post, confirm its forum thread is deleted from the marketplace channel (not just archived/left behind)
- [ ] For a purged listing with no forum thread (e.g. never posted), confirm the purge still completes cleanly with no error
- [ ] In text-channel mode, purge an active listing — confirm its listing message is deleted and it disappears from the pinned listing index
- [ ] After an admin purge, open `data/marketplace_log.jsonl` — confirm an `admin_purge` entry with count in `details`

### 3.9o `/admin room config`

**What it does:** Sets the Discord category name used for `/room` private channels (default "Private Rooms").

- [ ] Run `/admin room config` with no options — confirm it shows the current category name
- [ ] Run `/admin room config category:Secret Rooms` — confirm it saves and the reply reflects the new name
- [ ] Create a room after changing the category — confirm it's placed under the newly configured category, creating it if it doesn't already exist

### 3.9p `/admin usage`

**What it does:** Shows, per this server, which slash commands (and subcommands) have been called and how many times, plus a count of how often each optional parameter was supplied — never the parameter values themselves. Tracking starts from whenever this feature was deployed; nothing is backfilled.

- [ ] 👑 Run as non-admin — confirm "requires Manage Server permission"
- [ ] On a server with no prior command activity since this feature was deployed, run `/admin usage` — confirm "No command usage recorded yet."
- [ ] Run a few different commands and subcommands (e.g. `/help`, `/library add`, `/admin event config location:...`), then run `/admin usage` — confirm each shows up as its full path (e.g. `/library add`, `/admin event config`) with an accurate call count, sorted most-used first
- [ ] For a command run with an optional parameter (e.g. `/admin event config location:...`), confirm the reply shows that parameter name and count (e.g. `location: 1`) — and confirm the actual value typed (e.g. the location text) never appears anywhere in the reply
- [ ] Run the same command again without that optional parameter — confirm the total call count increases but the parameter's count does not
- [ ] Confirm this is per-server: running commands on a different server the bot is in does not affect this server's counts

### 3.9q `/admin general config`

**What it does:** Sets the text channel where the general chat "🎮 Quick Actions" hub (1.9a/2.10a) is posted and pinned. Distinct from `/admin welcome config` (3.9j) — that's for the one-time new-member greeting; this is meant for an ongoing, already-populated channel like #general.

- [ ] Run `/admin general config` with no options — confirm it shows the current channel (or "*not set*")
- [ ] Run `/admin general config channel:#general` — confirm the "🎮 Quick Actions" message is posted and pinned there, and the reply confirms it
- [ ] Try setting a voice channel or other non-text channel — confirm "must be a regular text channel" error, and nothing is saved
- [ ] Run `/admin general config channel:#general` again pointing at the same channel — confirm the existing hub message is refreshed in place rather than a second one being posted
- [ ] 👑 Run as non-admin — confirm "requires Manage Server permission"

## 3.10 `/room` — Private Rooms

### 3.10a `/room create`

**What it does:** Creates a new private text channel visible only to whoever you mention, plus hosts and admins — hidden from everyone else. Posts a message pinging each invited person, and creates the channel under a separate category (default "Private Rooms", configurable via `/admin room config`, 3.9o) so it's never mixed in with event/archive channels. Requires a `date` (when the room auto-closes — see 4.8), unless `persist:true` is set, which creates a room with no expiration at all — see 3.10c to toggle this later. A persistent room's channel name and topic are prefixed with 📌 so hosts/admins can spot it in the channel list without opening it.

**Prerequisites:** none — any server member can run this, not just hosts/admins.

- [ ] Run `/room create people:@Alice @Bob date:August 22` — confirm a new channel is created under the "Private Rooms" category, and the ping message + confirmation both state it expires August 22
- [ ] Run `/room create people:@Alice persist:true` with no `date` — confirm the room is created with no expiration, the channel name and topic are prefixed with 📌, and the ping message + confirmation both say it persists until closed
- [ ] Confirm a normal (non-persistent) room's channel name and topic are **not** prefixed with 📌
- [ ] Attempt to create a room with neither `date` nor `persist:true` — confirm a clear "Provide a `date`..." error and no channel is created
- [ ] Run with an unparseable `date` (e.g. "whenever") — confirm a clear parse error and no channel is created
- [ ] Run with a `date` already in the past — confirm "That date has already passed" error and no channel is created
- [ ] Confirm the channel is hidden from `@everyone` — a member who wasn't mentioned and has no Host/Admin role cannot see it
- [ ] Confirm you (the creator), the mentioned people, and any Host/Admin role member can all see the channel
- [ ] Confirm a message posts in the new channel `@`mentioning each invited person
- [ ] Run with a `name` option — confirm the channel is named accordingly
- [ ] Run without a `name` option — confirm a reasonable auto-generated name is used instead
- [ ] Run with `people` containing no valid `@`mentions (e.g. plain text) — confirm a clear error and no channel is created
- [ ] Mention yourself along with others — confirm you aren't invited twice/duplicated
- [ ] Mention someone who has since left the server — confirm they're skipped with a note in the reply, and the room is still created for the remaining valid people
- [ ] Mention only people who've all left the server — confirm a clear "couldn't find any" error and no channel is created
- [ ] Create a second room in the same server — confirm it reuses the existing "Private Rooms" category rather than creating a duplicate

### 3.10b `/room close`

**What it does:** Deletes a private room. Must be run inside the room's own channel. The room's creator or any host/admin can close it — nobody else.

- [ ] Run inside a room you created — confirm the channel is deleted
- [ ] Run inside a room someone else created, as a Host or Admin — confirm it works
- [ ] Run inside a room someone else created, as a regular member with no elevated role — confirm "Only the room's creator or a host/admin can close this room" error, and the channel is **not** deleted
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 3.10c `/room persist`

**What it does:** Turns a private room's auto-expiration on (`enabled:true`) or off (`enabled:false`, requires a new `date`). Must be run inside the room's own channel. The room's creator or any host/admin can toggle it — nobody else. See 4.8 for how auto-expiration works. The channel's 📌 name/topic prefix updates immediately to match.

- [ ] Run `/room persist enabled:true` inside a room that has a `date` — confirm the reply says the room will no longer auto-expire, the channel name and topic gain the 📌 prefix, and it survives past its original expiration date
- [ ] Run `/room persist enabled:false` inside a persistent room, with a `date` — confirm the reply confirms the new expiration, the channel name and topic lose the 📌 prefix, and the room auto-closes on that date (4.8)
- [ ] Run `/room persist enabled:false` inside a persistent room, with **no** `date` — confirm a clear "Provide a `date`..." error and the room remains persistent
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can change this room's expiration" error, and nothing changes
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 3.10d `/room invite`

**What it does:** Adds more people to an existing private room, granting them channel access and updating the stored room record. Must be run inside the room's own channel. The room's creator or any host/admin can invite — nobody else.

- [ ] Run `/room invite people:@Carol` inside a room — confirm Carol gains access to the channel, is pinged in a message, and the confirmation reply says she was added
- [ ] Confirm the newly added person now shows up if the room is later inspected (e.g. they count toward "already in this room" on a repeat invite)
- [ ] Mention someone who's already the creator or an existing invitee — confirm a clear "isn't already in this room" error and no channel/reply changes
- [ ] Mention someone who has since left the server — confirm they're skipped with a note in the reply, and any other valid mentions are still added
- [ ] Mention only people who've all left the server — confirm a clear "couldn't find any" error
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can invite people to this room" error, and nobody is added
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 3.10e `/room kick`

**What it does:** Removes someone from an existing private room, revoking their channel access and updating the stored room record. Must be run inside the room's own channel. The room's creator or any host/admin can kick — nobody else. The room's creator cannot be kicked (close the room instead).

- [ ] Run `/room kick user:@Carol` inside a room Carol was invited to — confirm Carol loses access to the channel, a message announces her removal, and the confirmation reply says she was removed
- [ ] Attempt to kick the room's creator — confirm "You can't remove the room's creator..." error and nothing changes
- [ ] Attempt to kick someone who was never invited to this room — confirm a clear "hasn't been individually invited" error and nothing changes
- [ ] Run as a Host or Admin on a room you didn't create — confirm it works
- [ ] Run as a regular member with no elevated role on a room you didn't create — confirm "Only the room's creator or a host/admin can remove people from this room" error, and nobody is removed
- [ ] Run outside of any private room channel — confirm "This command must be run inside a private room channel..." error

### 3.10f Quick Actions Hub (button panel)

**What it does:** A pinned "🎮 Quick Actions" message posted automatically the moment a room is created, alongside the existing plain-text welcome message — buttons for 🎲 Suggest a Game, ➕ Invite, 👢 Kick, 📌 Toggle Auto-Expire, and 🔒 Close Room. The Suggest a Game button is the exact same one used in event channels (same modal, same underlying flow) — it just resolves this room instead of an event when tapped here. Invite/Kick use Discord's native member-picker (a dropdown of server members) instead of typing mentions or a user option, and Close Room adds a Yes/Cancel confirmation step that the slash command itself doesn't have, since a misplaced tap is easier than a mistyped command for something this irreversible. Every button enforces the same "room creator or host/admin" permission check as its slash-command equivalent.

- [ ] Create a room — confirm the "🎮 Quick Actions" message appears, pinned, alongside the separate plain-text welcome message
- [ ] Tap "🎲 Suggest a Game" — confirm the same modal/flow as the event-channel hub, correctly suggesting into this room
- [ ] Tap "➕ Invite" as an Admin on a room you didn't create — confirm a member-picker appears; selecting one or more people grants them channel access and adds them to the room, identical to `/room invite`
- [ ] Tap "👢 Kick" and select someone invited to the room — confirm they lose access, identical to `/room kick`
- [ ] Tap "👢 Kick" and select the room's creator — confirm "You can't remove the room's creator..." same as the command
- [ ] Tap "📌 Toggle Auto-Expire" on a room with a set expiration date — confirm it immediately becomes persistent (no modal), same as `/room persist enabled:true`
- [ ] Tap "📌 Toggle Auto-Expire" on a persistent room — confirm a modal asks for a new expiration date, and submitting it sets the date and turns persistence back off, same as `/room persist enabled:false date:...`
- [ ] Tap "🔒 Close Room" — confirm a "this cannot be undone" Yes/Cancel prompt appears rather than closing immediately, and that both Cancel and Yes work as expected

---

# Part 4 — System & Automated Behavior

These features are triggered by Discord events and scheduled timers rather than a slash command's permission check. Exercising them typically requires server ownership or Admin-level Discord permissions (adding/removing the bot, editing scheduled events), even though they aren't part of the tiered command model above.

## 4.1 Automatic Archiving (Event Completion)

**What it does:** When a Discord scheduled event is marked as "Completed" by the server, the bot automatically archives the associated channel. If the RSVP was a forum thread, it's tagged "Concluded" and locked/archived.

- [ ] Mark a test event as completed in Discord — confirm:
  - Event channel moves to Archive category
  - Lock-date message is posted in the channel
  - Channel remains writable for 7 days
- [ ] With a forum announcements channel, let an event auto-archive — confirm the forum thread is tagged "Concluded" and locked/archived

## 4.2 Delayed Channel Lock

**What it does:** 7 days after archiving, the bot locks the channel by setting `SendMessages: false` for everyone.

**Prerequisites:** run 4.1 first so there's an archived event channel to lock.

- [ ] Check `gamenights.json` for a record with `archived: true` and a `lockAt` date — confirm `locked` is not yet set
- [ ] After the `lockAt` date passes (or manually set `lockAt` to a past date and restart the bot) — confirm:
  - Bot sets `SendMessages: false` on the channel
  - Message posted: "This channel is now read-only"
  - Members can no longer post in the channel
  - `locked: true` is saved to `gamenights.json`
- [ ] Restart the bot with a past-due `lockAt` record — confirm the lock is applied on startup without waiting for the hourly check

## 4.3 Archived Channel Auto-Deletion

**What it does:** If an admin sets `archive_retention_days` (via `/admin event config`, see 3.9a) to a non-zero value, the bot permanently deletes an archived channel once that many days have passed since the lock date. A value of 0 (the default) disables auto-deletion entirely.

**Prerequisites:** run 4.2 first so there's a locked channel with a `lockAt` date to measure retention against.

- [ ] With `archive_retention_days` unset or `0` — confirm an archived/locked channel is never auto-deleted, no matter how old
- [ ] Set `archive_retention_days:14` via `/admin event config` — confirm the config summary shows "Archived channel retention: 14 days"
- [ ] Manually set a `lockAt` date far enough in the past to exceed retention (or wait it out) — confirm the channel is deleted from the server on the next hourly check
- [ ] Check `bot.log` — confirm `Auto-deleted archived channel for game night <id> after <N> days` is logged
- [ ] Set `archive_retention_days:3` (below the enforced minimum) — confirm it is silently floored to 7 days
- [ ] Set `archive_retention_days:0` after previously setting a positive value — confirm the config summary reverts to "Never auto-delete" and no further deletions occur

## 4.4 Auto Role Creation (`guildCreate`)

**What it does:** When the bot is added to a new server, it automatically creates two Discord roles — **Admin** (red, with ManageGuild/ManageEvents/ManageRoles/ManageMessages/ManageChannels) and **Host** (blue, with ManageEvents/ManageMessages) — so the server owner can immediately assign the right people without manually creating roles.

- [ ] Add the bot to a brand-new test server — confirm two roles appear: **Admin** (red) and **Host** (blue)
- [ ] Confirm the **Admin** role has at minimum: Manage Server, Manage Events, Manage Roles, Manage Messages, Manage Channels
- [ ] Confirm the **Host** role has at minimum: Manage Events, Manage Messages
- [ ] Check `bot.log` — confirm `[GuildCreate] Created "Admin" role in <server>` and `[GuildCreate] Created "Host" role in <server>` lines appear
- [ ] Remove the bot and re-add it to a server where the Admin and Host roles already exist — confirm `[GuildCreate] "Admin" role already exists — skipping` and same for Host; no duplicate roles created
- [ ] Assign the **Host** role to a test member — confirm they can see `/host` commands but not `/admin` commands
- [ ] Assign the **Admin** role to a test member — confirm they can see both `/admin` and `/host` commands

## 4.5 Guild Data Lifecycle (`guildDelete` / Restore / Purge)

**What it does:** When the bot is removed from a server, its data (game nights, library, config, tags, BGG links, collections) is marked for deletion rather than deleted immediately. If the bot is re-added within 30 days, the marker is cleared and all data is restored automatically. If 30 days pass without the bot returning, a daily cleanup job permanently purges that guild's data from every storage file.

- [ ] Remove the bot from a test server — confirm `bot.log` shows `[GuildDelete] Bot removed from "<server>" — data marked for deletion in 30 days`
- [ ] Confirm the guild's entry appears in `data/deleted_guilds.json` with a `deletedAt` timestamp
- [ ] Re-add the bot to the same server within the 30-day window — confirm `bot.log` shows `[GuildCreate] Bot re-added to "<server>" — data restored (was pending deletion)`
- [ ] Confirm the guild's entry is removed from `deleted_guilds.json` and prior data (library, config, tags, etc.) is intact after rejoining
- [ ] Manually set a guild's `deletedAt` to more than 30 days ago and trigger the retention cleanup (restart the bot, or wait for the daily interval) — confirm `bot.log` shows `[GuildLifecycle] Retention window expired for "<server>" — purging data` followed by `[GuildLifecycle] Purged all data for guild <id>`
- [ ] After purge, confirm the guild's entries are gone from `gamenights.json`, `library.json`, `games.json`, `privateRooms.json`, `config.json`, `bgg_accounts.json`, `gameroles.json`, and `user_collections.json`, and any `library_requests.json` entries pointing to that guild's (now-deleted) events are also removed
- [ ] Confirm a guild that is NOT past the 30-day window is untouched by the cleanup job

## 4.6 Automatic Welcome (New Member Join)

**What it does:** When a new member joins the server, the bot sends a welcome DM and posts a message in the configured welcome channel.

**Requires a second account — moved to Part 5.2.** Triggering this needs an account actually joining the server (a `guildMemberAdd` event), which requires a second identity or a kick-and-reinvite of an alt — see Part 5.2 below.

## 4.7 Lineup Lock + Scheduler

**What it does:** `lock_hours_before_event` (via `/admin event config`, 3.9a) defaults to 48h — locking is on out of the box; set it to `0` to disable it entirely. When non-zero, the bot locks an event's game suggestions and seats that many hours before its start time, then posts a suggested schedule packing the suggested games into rounds across parallel tables so no player is double-booked in the same round. `table_count` (3.9a) is now a **floor, not a fixed number** — the bot computes an effective table count at lock time from how many people RSVP'd "yes" and their `/myroles` complexity preferences (see the "Smart table-count sizing" subsection below), and uses whichever is higher. Game durations use each game's stored playtime plus a teach/overflow buffer based on its complexity (Light/Medium/Heavy — also configurable via 3.9a). This runs on the same hourly check as archiving (4.1-4.3), plus once on bot startup.

Round headers show real clock start/end times (Discord's auto-localizing `<t:...:t>` timestamp markup), computed by summing round durations from the event's start time — not just an estimated duration. Within a round, a table that finishes its first game before the round's longest table (the "anchor" — whichever game set that round's duration) doesn't just sit idle: the scheduler chains other still-unplaced games onto that table, back-to-back, best-fitting whichever remaining game leaves the least time behind, until no more will fit — so as many tables as possible start and end together, and the game night converges on a shared reconvene time rather than tables finishing at scattered moments. A table playing more than one game in a round shows each game on its own line with its own `(<t:...:t>–<t:...:t>)` start/end time; a table playing only one game keeps the plain one-line form (its timing is already covered by the round header). Every table line also lists that game's seated players as `@mention`s (comma-separated) right after the title/time, so it doubles as a call sheet — no lookup elsewhere needed to see who's supposed to be at which table when. A game with no seated players (shouldn't normally happen for anything that made it into a round) simply omits the player list rather than showing an empty dash. Only the *last* game in a table's chain can opportunistically repeat into any remaining leftover time — under 30 minutes of raw playtime, before the complexity buffer — up to `max_game_repeats` total plays (3.9a); its line notes the play count, e.g. "(3x)". If any one table would play two Heavy-complexity games back-to-back — whether chained within the same round or across two directly consecutive rounds — a `heavy_game_break_minutes`-long break (3.9a) is inserted beforehand; a within-round break only pushes that table's own remaining chain, while a cross-round break is global and delays every table's next round, not just the offending one. Games with exactly one seated player are pulled into a separate "Needs more players" section instead of being scheduled or counted as "Not scheduled" (this applies even if that game's own minimum player count is 1 — a behavior change from before this feature, when a 1-seated game with `minPlayers:1` would have been scheduled normally).

If a round's cumulative start time — summed from the event's start across every prior round and inserted break — runs past the event's configured end time, every game in that round gets a "⚠️ This round is projected to start and/or run past the event's end time" note in its round's field. This is a per-round check (all tables in a round share the same start/end clock), separate from the whole-schedule `fitsInWindow` check that drives the embed's overall color and footer text — a schedule can fit overall while an individual late round still gets flagged, and vice versa isn't possible (the last round's flag and the footer always agree). An event with no configured end time never shows this warning, since there's no window to run past.

If the event has greeters set (`/host event greeters`, 2.8f), a "👋 Greeters" field listing them (`@mention`s, "and"-joined for two) appears as the very first field, ahead of the round breakdown. Events with no greeters set show no such field at all.

Locking also cleans up and follows up on the "Games to Bring" request pin (`/library request`, 1.4h/2.4h/3.4h) — in this order, all before the public schedule embed is posted: (1) any request whose title matches a suggested game that ends up with zero seated players is dropped and the pin is refreshed, even if an owner had already confirmed bringing it via `/library bring` — nobody signed up to play it, so there's no reason to ask an owner to lug it over; if that request had a pending "please bring this" DM outstanding, that DM is edited to say it's no longer needed and its button removed; (2) every request still on the pin at this point gets asked, for real, for the first time — no "please bring this" DM goes out before lock (see 1.4h), so this is the actual first ask for nearly every request, not a reminder to someone already pending. The bot picks whichever attending owner currently has the fewest confirmed brings for the event (or an explicitly copy-selected owner, if the requester picked one), same fairness logic as an immediate post-lock request. A request already fully covered by a proactive `/library bring` confirmation before lock isn't asked at all. A request with no matching suggested game at all (e.g. something brought along just to teach or show off, never suggested as a game to play) is left alone by the drop step — it was never tied to the signup system in the first place — but is still asked at lock like any other request. A request whose game has no owner in the library at all is simply left unasked (nobody eligible).

**Prerequisites:**
- `lock_hours_before_event` at its default (48h) or another non-zero value via `/admin event config` (3.9a) — this is on by default, so no setup is needed unless you want a different threshold.
- An event with several suggested games (`/game suggest`, 1.3a), seated by more than one confirmed player each — use several test accounts so some games can be given overlapping players (to see round conflicts) and others distinct players (to see them land in the same round). Include a mix: at least one Light/Medium/Heavy game, one game under 30 minutes playtime, two Heavy games that can land on the same table in consecutive rounds, and one game with exactly 1 seated player.
- To trigger the lock without waiting for real time to pass, manually set a game night's `startTimeISO` in storage to fall within the configured lock window and wait for the next hourly check (or restart the bot).
- To test the BG Stats buttons specifically, also set `post_bgstats_links:true` (3.9a), and link at least one seated test account's BGG account (`/bgg link`) so you can see the username-vs-display-name fallback in action.

- [ ] With the lock threshold crossed, confirm the bot posts a "🔒 Lineup Locked" embed in the event channel listing each round's table assignments
- [ ] With greeters set on the event (2.8f) before it locks, confirm the locked schedule embed's first field is "👋 Greeters" listing them by mention, ahead of the Round 1 field
- [ ] With no greeters set, confirm the schedule embed has no "👋 Greeters" field at all
- [ ] Confirm round headers show real `<t:...:t>` start/end clock times, not just an estimated duration
- [ ] Confirm each table's line lists that game's seated players as `@mention`s, comma-separated, after the title (and after the time range, for a chained table's slot)
- [ ] Confirm two games that share a seated player never appear in the same round
- [ ] Confirm two games with no shared players can land in the same round (up to the effective table count per round — see "Smart table-count sizing" below)
- [ ] Set up a round with one long ("anchor") game at one table and two or more shorter, non-conflicting games available — confirm the shorter games get chained onto another table back-to-back (not just the first one, with the rest pushed to a later round), each shown on its own line with its own `(<t:...:t>–<t:...:t>)` start/end time, and that the chain's total lands at or before the anchor's own end time
- [ ] Confirm a table playing only one game in a round still shows the plain "Table N: **Title**" line with no per-slot time range attached
- [ ] With three or more tables available, one already holding a short partial chain with just enough leftover time and another table still completely empty — add a game that fits either — confirm it's best-fit onto the table with the tighter leftover rather than spreading onto the empty table
- [ ] Seat a <30-min game as the **last** game in a table's chain, alongside a much longer game at another table — confirm its table line shows a play-count suffix like "(2x)" or "(3x)", and that the round's own duration is unaffected by the repeat
- [ ] Seat a <30-min game earlier in a chain (with another game placed after it in the same table) — confirm it does **not** get a repeat suffix; only the chain's last game is eligible
- [ ] Confirm a short game that itself sets its round's duration (nothing else at another table runs longer) never gets a repeat
- [ ] Set `max_game_repeats:2` (3.9a) — confirm repeats are capped at 2 even where leftover time would allow 3
- [ ] With `heavy_game_break_minutes` set (3.9a), seat two Heavy-complexity games so they land at the same table in consecutive rounds — confirm a break note appears before the second round, and that *every* table's next round start time shifts by the break amount, not just the table that triggered it
- [ ] With `heavy_game_break_minutes` set, chain two Heavy-complexity games back-to-back at the *same table within the same round* (e.g. behind a longer Heavy anchor at another table) — confirm the second Heavy game's start time is pushed back by the break, without affecting any other table's round start
- [ ] Chain a Heavy game directly after a non-Heavy game at the same table within a round — confirm no break is inserted between them
- [ ] Confirm two Heavy games at the same table with a non-Heavy game in between (round 1, 2, 3 respectively) do **not** trigger a break — this is a known limitation, only literally back-to-back rounds (or back-to-back chain slots) are checked
- [ ] Seat exactly 1 player on a game — confirm it appears under a "Needs more players" section, separate from "Not scheduled", even if that game's own minimum player count is 1
- [ ] Confirm a game below its minimum player count (with 2+ seated) appears under "Not scheduled" with a reason, rather than being silently dropped
- [ ] Confirm the embed footer notes whether the estimated total fits within the event's start–end window, and includes any inserted break minutes in the total when present
- [ ] Set up an event whose suggested games clearly overrun `end_time` (seat enough non-overlapping games, or a short `end_time`, that a later round's cumulative start pushes past it) — confirm that round (and only that round) shows the "⚠️ This round is projected to start and/or run past the event's end time" note, while earlier rounds that still fit do not
- [ ] Confirm an inserted Heavy-game break (above) counts toward this cumulative check — a round that would fit on game time alone but is pushed over the window by the break's minutes still gets flagged
- [ ] With no `end_time` set on the event, confirm no round is ever flagged, regardless of total length
- [ ] After locking, run `/game suggest` in that event's channel — confirm it's rejected with a lineup-locked message instead of prompting to add a game
- [ ] After locking, click **Join** or **Leave** on an existing game card — confirm both are rejected with the same lineup-locked message
- [ ] After locking, click **Join Waitlist** or **Leave Waitlist** — confirm both are rejected the same way
- [ ] Confirm an event is only locked/scheduled once — running the hourly check again after locking doesn't re-post the schedule or re-lock
- [ ] Confirm a cancelled or already-archived event is never locked/scheduled, even past its threshold
- [ ] Set `lock_hours_before_event` back to `0` — confirm no further events get locked, and existing unlocked events remain fully open
- [ ] Request a game (`/library request`, 1.4h) that ends up with zero seated players at lock — confirm the request disappears from the "Games to Bring" pin after locking, even if `/library bring` (1.4j) was used to confirm it beforehand
- [ ] Request a game that keeps at least one seated player through lock, alongside a zero-seat one — confirm only the zero-seat game's request is dropped; the other remains on the pin
- [ ] Request a game that was never suggested via `/game suggest` at all (no matching `GameSuggestion`) — confirm it's left on the "Games to Bring" pin after lock, since it was never part of the signup system to begin with
- [ ] Confirm locking an event with no zero-seat requests to drop doesn't touch or re-post the "Games to Bring" pin at all
- [ ] Request a game that keeps its seated players through lock, and leave it unconfirmed via `/library bring` (1.4j) — confirm an owner (whichever attending owner has the fewest confirmed brings for the event) receives the "please bring this" DM with a "✅ Confirm bringing" button only once the event locks, not at request time
- [ ] Confirm an owner who already confirmed via `/library bring` (proactively, before lock) does **not** get asked at all
- [ ] Confirm the zero-signup drop and the owner-asking pass happen before the "🔒 Lineup Locked" schedule embed is posted, not after
- [ ] Request a game that ends up with zero seated players — since no DM is sent until lock, and the drop check runs first, its owner is never asked in the first place; there's no dangling DM to edit for a request created and dropped entirely within one lock cycle

**Smart table-count sizing:**

The effective table count used at lock time is `max(headcount floor, preference-split floor, table_count)`. The **headcount floor** assumes real games seat 3-6 players: it checks how evenly the RSVP "yes" count divides by 3, 4, 5, and 6 (normalized by the decimal remainder, not raw remainder, so e.g. 13 people cleanly picks size 6 → 3 tables, not a tie between sizes 3/4/6), and ties prefer the larger size (fewer, fuller tables). The **preference-split floor** sums a same-formula floor across however many of Light/Medium/Heavy have RSVP'd members with that exact `/myroles` complexity preference set — members with no preference set don't count toward any tier. Neither calculation reassigns or contacts any player; it only sizes how many parallel tables the round-packer is allowed to use.

- [ ] With `table_count:1` and fewer than 3 RSVP "yes"s, lock the event — confirm the schedule still only uses 1 table (both floors are ≤1)
- [ ] With `table_count:1` and 13 RSVP "yes"s (none with a `/myroles` complexity preference set), and 3 mutually non-conflicting suggested games, lock the event — confirm all 3 land in round 1 across 3 separate tables (the headcount floor for 13 people is 3 tables), rather than 2 of them being pushed to later rounds as they would under the flat `table_count:1` default
- [ ] With `table_count:1`, RSVP 3 members who set `/myroles` complexity to Light and 3 who set it to Medium (6 total), and 2 non-conflicting suggested games (one Light, one Medium) — confirm both can land in round 1 (preference-split floor of 2 outranks the headcount floor of 1 for a homogeneous group of 6)
- [ ] Confirm a member who RSVP'd "yes" but has since left the server doesn't break the lock — they're silently skipped rather than counted in either floor
- [ ] Confirm `table_count` still acts as a true floor — set it higher than either computed floor (e.g. `table_count:5` with only a couple of RSVPs) and confirm the event still gets sized for at least 5 tables

**`/admin event preview` (dry run):**
- [ ] Before the lock threshold is reached, run `/admin event preview` inside an event channel — confirm it shows an ephemeral embed shaped the same as a real lock's schedule embed (rounds with clock times, repeats, breaks, "Needs more players", "Not scheduled")
- [ ] After running the preview, confirm suggestions are still unlocked — `/game suggest` still works, and Join/Leave on game cards still works normally
- [ ] Confirm nothing is posted to the event channel itself, and no games have `scheduledRound`/`scheduledTable`/`scheduledPlayCount` set in storage after a preview
- [ ] Run `/admin event preview` again after changing `table_count`, `heavy_game_break_minutes`, or `max_game_repeats` (3.9a) — confirm the preview reflects the new config immediately
- [ ] Run `/admin event preview` in a channel that isn't an event channel — confirm a clear "isn't an event channel" ephemeral error instead of a crash

**With `post_bgstats_links:true`:**
- [ ] Confirm a separate message with a QR code image is posted for each *scheduled* game (not for games listed under "Not scheduled")
- [ ] **With `SHORT_LINK_BASE_URL` configured** (see 4.7a below): confirm a "📊 Log in BG Stats" button is present regardless of how many players are seated, and tapping it opens directly to a new-play screen pre-filled with the correct game, location (the event's configured location), and the full seated roster for that table
- [ ] **Without `SHORT_LINK_BASE_URL` configured**: confirm the button is **omitted** for essentially any game with at least one seated player (the full BG Stats payload — including the `winner`/`startPlayer`/`highestWins`/`noPoints` fields BG Stats' app requires — now exceeds Discord's 512-char limit even for a solo play) and the message text explains why ("too many players for a tappable link") rather than silently vanishing
- [ ] Scan the QR code with a phone camera — confirm it scans quickly and decodes to (or, via the short link, redirects to) the exact same play details regardless of player count. The QR encodes the short link when one exists (small/simple code, easy to scan) and only falls back to the full raw link when `SHORT_LINK_BASE_URL` isn't configured (denser code, still functional but harder for a camera to lock onto)
- [ ] Scan the QR code (or tap the button) and confirm BG Stats opens the pre-filled play screen **without** an "Invalid data" JSON error (regression: BG Stats' Android app requires explicit `winner`, `startPlayer`, `highestWins`, and `noPoints` values even though all four are documented as optional — omitting any of them threw `JSONException: No value for <field>`)
- [ ] For a scheduled game with a BGG id, confirm BG Stats opens successfully on iOS **and** macOS/Mac Catalyst without crashing (regression: `game.bggId` was sent as a quoted JSON string instead of the number BG Stats' schema expects, throwing a Core Data type-coercion exception — crashed outright on macOS, and silently closed the app on iOS)
- [ ] For a seated player with a linked BGG account (`/bgg link`), confirm their BGG username is used as their player name in BG Stats rather than their Discord display name
- [ ] For a seated player without a linked BGG account, confirm their Discord display name is used instead

### 4.7a BG Stats short-link redirect service

**What it does:** Backs the "Log in BG Stats" button with a short `https://<domain>/s/<code>` URL instead of the full BG Stats deep link, so the button stays under Discord's 512-character link limit no matter how many players are seated. Visiting the short link serves a small landing page ("Log this play in BG Stats") with an "Open BG Stats" link, then auto-forwards to BG Stats after a 2-second pause — the pause gives the user context on what's about to happen, and the page still forwards on its own for anyone who doesn't tap the button. Requires `SHORT_LINK_BASE_URL` to be set to a public domain generated for this Railway service (Settings → Networking → Generate Domain); the bot listens on Railway's injected `$PORT`. If unset, this feature no-ops entirely — buttons fall back to the old "only if the raw link is short enough" behavior (see 4.7 above).

- [ ] With `SHORT_LINK_BASE_URL` set and the service redeployed, confirm the button's link is a short `<domain>/s/<code>` URL (not the raw `bgstatsapp.com` link) even for a large table
- [ ] Confirm the QR code image also encodes that same short link rather than the raw `bgstatsapp.com` URL — visually it should look noticeably simpler/less dense than before this was added, and should scan quickly with a phone camera
- [ ] Visit that short link directly in a browser — confirm it shows the "Log this play in BG Stats" landing page (not an instant silent redirect), and that it auto-forwards to the pre-filled BG Stats play screen on its own after ~2 seconds
- [ ] On the same page, tap/click the "Open BG Stats" link right away — confirm it takes you to the pre-filled play screen immediately, without waiting for the auto-forward
- [ ] **On an iPhone specifically**, confirm the auto-forward opens BG Stats and it *stays open* rather than flashing open and immediately closing (watch closely: Apple's universal-link activation is documented to require a genuine tap rather than a timed/automatic redirect like this one — this auto-forward was removed once already over reports of exactly this symptom, then re-added after a separate root cause, a `game.bggId` type bug, was found and fixed; if this recurs, the safest fix is to skip the meta-refresh for iOS user agents specifically rather than removing it for everyone)
- [ ] Visit `<domain>/s/<made-up-code>` — confirm a "Link not found" landing page (404) that does **not** auto-forward anywhere, rather than a crash or an open redirect to an arbitrary URL
- [ ] Confirm `/game bgstats` (1.3g) also produces a short-link button under the same configuration
- [ ] With `post_bgstats_links:false` (the default), confirm no BG Stats messages are posted at all — only the existing "🔒 Lineup Locked" schedule embed

## 4.8 Private Room Expiration

**What it does:** Every private room (`/room create`, 1.8a) has an expiration date, unless it was created with `persist:true` or later switched to persistent via `/room persist enabled:true` (1.8c). On the same hourly check as archiving and the lineup scheduler (plus once on startup), the bot closes any non-persistent room whose expiration date has passed — deleting the channel and its stored record — exactly as if `/room close` had been run. Persistent rooms are skipped by this check entirely, regardless of any stored `expiresAt`.

**Prerequisites:** a private room whose `date` has already passed — either wait for a room to actually expire, or manually edit its `expiresAt` in `data/privateRooms.json` to a past timestamp and wait for the next hourly check (or restart the bot).

- [ ] With a room's expiration date in the past, confirm the channel is deleted on the next hourly check (or bot startup) without anyone running `/room close`
- [ ] Confirm the room's entry is removed from `data/privateRooms.json` once expired
- [ ] Confirm a room whose expiration date hasn't passed yet is left untouched by the same check
- [ ] Confirm `/room close`, run manually before the expiration date, still works exactly as before (expiration doesn't interfere with early manual closing)
- [ ] Confirm a persistent room (created with `persist:true`, or switched via `/room persist enabled:true`) is left untouched by the hourly check even after its original/former expiration date would have passed

---

# Part 6 — General Edge Cases (Any Role)

Run through this section once, regardless of which tier you're testing.

- [ ] Run any command in a DM (outside a server) — confirm graceful failure
- [ ] Run `/game suggest` in a channel with no active event and no upcoming events — confirm "There are no upcoming events" message
- [ ] Attempt to RSVP to a cancelled event — confirm the embed is removed or no longer responds
- [ ] Suggest a game when the event's channel has been archived — confirm "no longer active" message
- [ ] Verify bot handles BGG being unreachable — confirm graceful fallback to local catalog or manual entry
- [ ] Confirm all ephemeral responses are only visible to the invoking user
- [ ] Search BGG for a game with an apostrophe or ampersand in its name (e.g. "Star Trek: Captain's Chair") — confirm it displays with a real apostrophe/ampersand, not raw HTML entities (`&#039;`, `&amp;`), in the search dropdown, the game lineup list, and the "Games to Bring" list
- [ ] Manually un-pin the game lineup or "Games to Bring" message in an event channel, then trigger any update to it (e.g. suggest/cancel a game) — confirm the bot re-pins it automatically rather than leaving it unpinned
- [ ] Run `/event list` — confirm each event's date/time renders as a Discord timestamp (shows in your local time, updates live rather than being frozen text)
- [ ] Start `/marketplace post sell` up to the price-selection step (a "Set Custom Price" button visible), restart/redeploy the bot, then click the button — confirm it still works instead of saying the session expired (regression: in-progress sell/trade drafts previously lived only in memory and were lost on any bot restart)

---

# 👥 Multi-Person Tests

This is the entire group of tests that need a second, distinct Discord identity — save this section for a session when a second tester is actually around, and knock it all out in one sitting. Grouped by tier first (which permission level the flow needs), then by which pairing you need to recruit within that tier.

---

# Part 5 — Multi-Person Tests

These test cases involve genuine back-and-forth between two distinct Discord identities, or a real join event — they can't be completed by one tester working alone, even with several test accounts on hand. Grouped by tier (5.1 is a Member-tier flow; 5.2 is a System/Automated flow), then by which pairing you need to recruit within that.

**Prerequisites:**
- A second, distinct Discord account (see the global Prerequisites section above — reusing one of your three test accounts is fine).
- For 5.1: a marketplace channel configured (`/admin marketplace config`, 3.9m), and one account with an active sell or trade listing posted (`/marketplace post sell`/`post trade`, 1.7a/1.7b).
- For 5.2: a welcome channel configured (`/admin welcome config`, 3.9j).

## 5.1 Buyer + Seller — Marketplace Negotiation *(Member-tier flow — neither side needs an elevated role)*

### 5.1a "I'm Interested" button flow

**What it does:** Buyer clicks button, modal opens, an offer is submitted, seller is notified. Firm-price listings also show a "Buy It Now" button that skips the seller-review step entirely — see the dedicated subsection below.

**Fixed-price sell listing:**
- [ ] Click "I'm Interested" on a firm-price listing — confirm modal opens with a message field only (no offer amount field)
- [ ] Submit the modal — confirm seller gets a DM notification headed "New offer on your **{item}** listing:" with **Accept/Deny only — no Counter button**, since a firm price has nothing left to negotiate
- [ ] Confirm the DM buttons disappear and a result stamp appears after the seller acts

**"Buy It Now" (firm-price listings only):**
- [ ] Confirm a firm-price listing shows **both** a "⚡ Buy It Now" button and the "🤝 I'm Interested" button; confirm a negotiable sell listing or a trade listing shows only "I'm Interested" (no Buy It Now)
- [ ] Click "Buy It Now" — confirm an ephemeral confirmation prompt appears naming the item and price, with Confirm Purchase / Cancel buttons, and a note that this is final
- [ ] Click "Cancel" — confirm the prompt updates to "Purchase cancelled." and the listing is untouched (still active, no offer created)
- [ ] Click "Confirm Purchase" — confirm: the listing is immediately marked 🔴 Sold (no seller review step); the buyer's prompt updates to "✅ Purchase confirmed! **{item}** is now marked as sold."; the seller gets a DM ("⚡ {buyer} just bought **{item}** with Buy It Now for {price}!") without ever seeing an Accept/Deny prompt; a "⚡ Sold instantly!" post appears in the forum thread before it archives
- [ ] If the seller has the item in their `/library`, confirm their Buy-It-Now DM includes the "remove it now that it's sold?" prompt and buttons, same as the regular Accept flow
- [ ] With an existing pending "I'm Interested" offer from a different buyer on the same firm listing, click "Buy It Now" as a third user and confirm — confirm the original offer's buyer gets a "sold to someone else via Buy It Now" DM and their Accept/Deny DM prompt is closed out (🔒 Closed), exactly like a regular Accept would do
- [ ] Attempt "Buy It Now" on your own listing — confirm "You can't buy your own listing" error
- [ ] Attempt "Buy It Now" on a listing that's already sold/closed — confirm "This listing is no longer available"
- [ ] Simulate two people confirming a purchase on the same listing back-to-back (e.g. two browser tabs / two accounts clicking Confirm Purchase in quick succession) — confirm only the first succeeds and the second gets "this listing is no longer available — someone else may have just bought it" instead of a duplicate sale

**Negotiable sell listing:**
- [ ] Click "I'm Interested" on a negotiable listing — confirm modal shows asking price as reference and an offer-amount field labeled "Your offer"
- [ ] Enter an offer amount and submit — confirm the offer is posted in the forum thread (public mode) or private thread (private mode), using the same "New offer on your ... listing" wording as the firm-price case above (there's no separate "bid" wording anywhere anymore)
- [ ] Confirm seller gets DM with the offer amount and Accept/Deny/Counter buttons
- [ ] Confirm listing status updates to 🟡 Pending in the forum post
- [ ] Click "I'm Interested" again as the same user — confirm error: "You already have an open offer"
- [ ] Click "I'm Interested" as the seller — confirm error: "You can't make an offer on your own listing"

**Trade listing:**
- [ ] Click "I'm Interested" on a trade listing — confirm modal shows "What are you offering in exchange?" field instead of a price field
- [ ] Submit with offer text — confirm offer appears in the forum thread notification

**Edge cases:**
- [ ] As buyer, submit an offer amount of 0 or a non-numeric value on a negotiable listing — confirm graceful validation rather than a broken offer
- [ ] Have two different buyer accounts both open offers on the same negotiable listing — confirm the seller sees both as separate open offers and can act on each independently

### 5.1b Negotiation — Accept / Deny / Counter

**What it does:** Seller responds to offers with Accept, Deny, or Counter buttons sent via DM (or thread fallback if DMs are disabled).

**Accept:**
- [ ] Seller clicks Accept on an offer in their DM — confirm the DM message updates to "✅ Accepted — deal done!" with buttons removed
- [ ] Confirm listing status becomes 🔴 Sold in forum post — note the underlying status value is `sold` for both sell **and** trade listings (there's no separate "traded" status), but every message below uses type-aware wording: "sold" for a sell listing, "traded" for a trade listing
- [ ] Confirm the seller's ephemeral reply reads "Offer accepted! **{item}** is now marked as sold" for a sell listing, or "...marked as traded" for a trade listing
- [ ] Confirm buyer gets DM: "Your offer on **{item}** was accepted by {seller}!"
- [ ] If other open offers exist, confirm those buyers get DM: "Sorry, **{item}** has been sold to someone else" (or "...traded to someone else" for a trade listing), **and** confirm their outstanding Accept/Deny/Counter (or Accept Counter/Decline) DM prompt is edited to show "🔒 Closed — this listing has been sold to someone else." (or "...traded to someone else." for a trade listing) with its buttons removed
- [ ] With an outstanding counter on one of the other offers, confirm accepting a different offer also closes that counter's DM prompt (same 🔒 Closed message) rather than leaving it clickable
- [ ] Confirm a "Deal done!" conclusion post appears in the forum thread before it archives, using the same type-aware wording — "...is now sold" for a sell listing, "...is now traded" for a trade listing
- [ ] If the seller has the sold/traded item in their `/library`, confirm the follow-up removal prompt reads "...now that it's sold?" for a sell listing or "...now that it's traded?" for a trade listing
- [ ] Confirm forum thread is archived

**Deny:**
- [ ] Seller clicks Deny — confirm DM message updates to "❌ Declined — offer denied." with buttons removed
- [ ] Confirm buyer is notified
- [ ] If no other open offers, confirm listing reverts to 🟢 Active
- [ ] If other offers still open, confirm listing stays 🟡 Pending

**Counter (negotiable sell listings and trades only — see firm-listing note below):**
- [ ] Seller clicks Counter — confirm modal opens for counter amount and message
- [ ] Confirm DM message updates to "💬 Counter offer sent — waiting for response." with buttons removed
- [ ] Buyer receives DM with counter details and Accept/Decline buttons
- [ ] Buyer accepts counter — confirm buyer's DM updates to "✅ Accepted" with buttons removed; listing becomes Sold (using the same sold/traded type-aware wording as the Accept section above); seller is notified via DM, including the same library-removal prompt if applicable; any other open offers get the same sold/traded "someone else" messaging as Accept above
- [ ] Buyer declines counter — confirm DM updates to "↩️ Withdrawn" with buttons removed
- [ ] Countering one offer leaves any other open offers on the same listing untouched — confirm the seller can still Accept/Deny/Counter those independently

**Firm-price listings have no Counter at all:**
- [ ] On a firm-price listing, confirm the seller's DM never shows a Counter button — only Accept/Deny
- [ ] If a stale/old Counter button somehow gets clicked on a firm listing, confirm the bot replies "This is a firm-price listing — there's no price to counter" instead of opening a modal

**Interacting via DM specifically (not a forum-thread fallback):**
- [ ] Confirm Accept clicked from the seller's DM works (no "Listing not found" error) — this is the normal path since these buttons are always sent via DM first
- [ ] Confirm Deny clicked from the seller's or buyer's DM works (no "Listing not found" error)
- [ ] Confirm Counter clicked from a DM, and the resulting counter-offer modal submission, both work (no "Listing not found" error)

**Edge cases:**
- [ ] Disable "Allow direct messages from server members" on the seller's account before a buyer submits an offer — confirm the Accept/Deny/Counter prompt falls back to a thread instead of failing silently (per the "What it does" note above)
- [ ] Seller tries to act on an offer a second time after already accepting/denying it (e.g. a stale DM with old buttons) — confirm the bot replies "This offer is no longer open" and strips the stale buttons, rather than double-processing it

### 5.1c Negotiation modes (public vs. private)

**What it does:** Controls whether offer negotiation is visible publicly in the forum thread or in a private thread.

- [ ] With negotiation_mode=public: click "I'm Interested" — confirm offer notification posted in the public forum thread (visible to all); Accept/Deny/Counter buttons go to seller via DM
- [ ] With negotiation_mode=private: click "I'm Interested" — confirm a private thread is created with buyer, seller, and bot; offer notification posted there; buttons go to seller via DM

**Edge cases:**
- [ ] 👑 In private mode, have a third account (neither buyer nor seller) try to view or join the private negotiation thread — confirm they cannot see it (a server owner can typically still see private threads via Discord's own `Manage Threads` permission, which owners always have — this isn't a bot bug, it's Discord's platform behavior)

## 5.2 New Member Join — Welcome Flow *(System/Automated flow — triggered by a real `guildMemberAdd` join event, not a slash command permission tier)*

**What it does:** When a new member joins the server, the bot sends a welcome DM and posts a message in the configured welcome channel.

- [ ] Have a second account join the server (a fresh account, or an existing test account you first kick and then re-invite) — confirm the welcome message is automatically sent to the welcome channel and to the new member via DM
- [ ] Confirm the welcome channel embed includes a link to the rules channel, Facebook group, and BGG group (if configured via `/admin welcome config`), plus a "📅 Events" field (not "Game Nights") pointing at the announcements channel, "🎮 Quick Actions" (`/hub`), "🏷️ Game Preferences" (`/myroles`), "📚 Browse the Library" (`/library list`), and "🎲 Suggest a Game" (`/game suggest`) fields — note it deliberately does **not** mention `/library add`, since a brand-new member shouldn't feel pressed to add their own games on day one
- [ ] Confirm the DM lists `/hub`, `/myroles`, `/library list`, and `/game suggest`, and points to both `/getting-started` and `/help` — and, like the channel embed, does not mention `/library add`

**Edge cases:**
- [ ] Trigger a join with `/admin welcome config` left at defaults (no rules channel, Facebook URL, or BGG URL set) — confirm the welcome message still sends cleanly without a broken link or placeholder text
- [ ] Disable DMs on the joining account beforehand — confirm the channel post still happens even if the DM can't be delivered
