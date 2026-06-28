# Rulebook Rebels Bot — Testing Guide

This document describes every feature in the bot and provides a checklist of test cases to verify correct behavior. All tests are performed in Discord using slash commands unless otherwise noted.

---

## Prerequisites

---

## 1. `/help`

**What it does:** Displays an ephemeral embed listing all available commands grouped by category. The Admin-only section is only shown to members with Manage Guild permission.

- [ ] Run `/help` as a regular member — confirm embed shows `/event`, `/game`, `/library`, and `/myroles` sections but **no Admin section**
- [ ] Run `/help` as an admin — confirm the **Admin only** section appears with all admin commands listed
- [ ] Confirm the response is ephemeral (only visible to you)

---

## 2. `/event` — Event Management

### 2a. `/event config` (Admin only)

**What it does:** Sets server-wide defaults used when creating events (location, start/end time, description, announcements channel, and whether event channels are open or RSVP-only).

- [ ] Run `/event config` with no options — confirm it shows current defaults
- [ ] Set a default location: `/event config location:Library Room 1` — confirm it saves
- [ ] Set a default start time: `/event config time:7:00 PM` — confirm it saves
- [ ] Set a default end time: `/event config end_time:10:00 PM` — confirm it saves
- [ ] Set an announcements channel: `/event config announcements:#announcements` — confirm it saves
- [ ] Set open channels to true: `/event config open_channels:True` — confirm it saves
- [ ] Set open channels to false: `/event config open_channels:False` — confirm it saves
- [ ] Set event category: `/event config event_category:Game Nights` — confirm new events are created under "Game Nights" category instead of "Monthly Events"
- [ ] Set archive category: `/event config archive_category:Old Events` — confirm archived events move to "Old Events" category instead of "Archive"
- [ ] Run `/event config` with no options — confirm current values for all fields including category names are displayed
- [ ] Confirm non-admin gets "Only admins can change event defaults" error

### 2b. `/event create` (Admin only)

**What it does:** Creates a Discord scheduled event, a text channel under the "Monthly Events" category, and posts an RSVP embed in the configured announcements channel.

- [ ] **Confirm non-admin gets "Only admins can schedule events" error** when running `/event create`
- [ ] Create an event with required fields only: `/event create date:August 22 time:7pm` — confirm:
  - Discord scheduled event is created in the server
  - A channel named `monthly-august-22` appears under "Monthly Events"
  - RSVP embed is posted in the announcements channel
  - Channel welcome message appears in the event channel
- [ ] Create an event with all fields: `/event create date:September 5 time:7:00 PM end_time:10:00 PM location:Community Center link:https://maps.google.com description:Bring snacks!`
- [ ] Confirm date formats work: `aug 22`, `August 22`, `august 22, 2026`
- [ ] Confirm time formats work: `7pm`, `7:00 PM`, `19:00`
- [ ] With `open_channels:False` — confirm the new channel is hidden from members not yet RSVP'd
- [ ] With `open_channels:True` — confirm the new channel is visible to everyone

### 2c. `/event list`

**What it does:** Lists all upcoming (non-cancelled, non-archived) game nights with IDs, dates, times, and RSVP counts.

- [ ] With at least one active event — confirm it shows the event with its ID and details
- [ ] With no active events — confirm it shows "No upcoming game nights scheduled"
- [ ] Confirm the response is ephemeral

### 2d. `/event cancel`

**What it does:** Cancels an event, deletes the Discord scheduled event, removes the RSVP embed, deletes the event channel (and all messages within it), deletes any game card messages that were posted outside the event channel, and purges all game suggestions and library requests for that event from storage.

- [ ] Cancel an event as the creator: `/event cancel id:<event-id>` — confirm event is removed
- [ ] Cancel an event as an admin (non-creator) — confirm it works
- [ ] Attempt to cancel as a non-admin, non-creator — confirm "Only the event creator or an admin can cancel this" error
- [ ] Attempt to cancel with an invalid ID — confirm "No event found" error
- [ ] Attempt to cancel an already-cancelled event — confirm "already cancelled" error
- [ ] Cancel an event that has game cards and library requests — confirm the event channel is deleted, all game card messages are gone, and running `/library request` for that event afterwards shows no stale requests

### 2e. `/event archive` (Admin only)

**What it does:** Manually archives channels for all past events that haven't been archived yet. Moves channels to an "Archive" category and posts a lock-date message.

- [ ] Run `/event archive` with no past events — confirm "No past event channels to archive"
- [ ] Run `/event archive` with a past event — confirm:
  - Channel moves to "Archive" category
  - Message posted: "This event has concluded. The channel will become read-only on [date 7 days out]"
  - Channel remains writable immediately after archiving
- [ ] Confirm non-admin gets "Only admins can archive events" error

### 2f. Automatic Archiving (Event Completion)

**What it does:** When a Discord scheduled event is marked as "Completed" by the server, the bot automatically archives the associated channel.

- [ ] Mark a test event as completed in Discord — confirm:
  - Event channel moves to Archive category
  - Lock-date message is posted in the channel
  - Channel remains writable for 7 days

### 2g. Delayed Channel Lock

**What it does:** 7 days after archiving, the bot locks the channel by setting `SendMessages: false` for everyone.

- [ ] Check `gamenights.json` for a record with `archived: true` and a `lockAt` date — confirm `locked` is not yet set
- [ ] After the `lockAt` date passes (or manually set `lockAt` to a past date and restart the bot) — confirm:
  - Bot sets `SendMessages: false` on the channel
  - Message posted: "This channel is now read-only"
  - Members can no longer post in the channel
  - `locked: true` is saved to `gamenights.json`
- [ ] Restart the bot with a past-due `lockAt` record — confirm the lock is applied on startup without waiting for the hourly check

### 2h. RSVP Buttons

**What it does:** Members click Going / Maybe / Can't Go on the RSVP embed to update their RSVP status. In RSVP-only mode, Going/Maybe grants access to the event channel.

- [ ] Click **Going** — confirm:
  - RSVP count updates in the embed
  - Member gains access to the event channel (if RSVP-only mode)
- [ ] Click **Maybe** — confirm similar behavior to Going
- [ ] Click **Can't Go** — confirm:
  - RSVP count updates
  - Member loses access to the event channel (if RSVP-only mode)
- [ ] Toggle between statuses (Going → Maybe → Can't Go → Going) — confirm counts stay accurate
- [ ] Remove "Interested" from the Discord scheduled event directly — confirm bot marks user as Can't Go

---

## 3. `/game` — Game Suggestions

All `/game` commands should be used inside an active event channel unless otherwise noted.

### 3a. `/game suggest`

**What it does:** Suggests a game for the event. Checks the group library first (exact match → partial match → BGG search). Prompts to add tags if not already tagged.

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
- [ ] Select a result — confirm game card is posted with BGG-sourced data
- [ ] If the BGG game has no tags — confirm tag picker appears
- [ ] Select tags, click Save — confirm tags appear on the game card and prompt to confirm bringing the game
- [ ] Click Skip on tag picker — confirm bring prompt appears

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

### 3b. `/game list`

**What it does:** Lists all games suggested for the current event channel with player count, duration, and seats. Must be used inside an event channel.

- [ ] Run `/game list` in an event channel with games — confirm all games appear with stats and jump links
- [ ] Run `/game list` in a channel with no games — confirm "No games have been added yet"
- [ ] Run `/game list` in a non-event channel (e.g. general) — confirm helpful error: "Use `/game list` inside an event channel…"

### 3c. `/game cancel`

**What it does:** Removes a game suggestion from the lineup. Only the suggester or a moderator can remove it.

- [ ] Remove your own game suggestion: `/game cancel title:Wingspan` — confirm card is deleted
- [ ] Attempt to remove another user's suggestion as a regular member — confirm "Only the person who suggested... can remove it" error
- [ ] Remove another user's suggestion as an admin — confirm it works
- [ ] Attempt to cancel a game not in the lineup — confirm "No game called X found" error

### 3d. Game Card Buttons — Join / Leave

**What it does:** Players click Join to take a seat in a game, Leave to vacate it.

- [ ] Click **Join** on a game card — confirm name appears in the seats list and count updates
- [ ] Click **Join** again on the same game — confirm "You're already in this game" error
- [ ] Click **Leave** — confirm name is removed and count updates
- [ ] Click **Leave** without being in the game — confirm "You're not in this game" error
- [ ] Fill all seats to the max player count — confirm the Join button becomes the Waitlist button

### 3e. Game Card Buttons — Waitlist

**What it does:** When a game is full, players join a waitlist. If the waitlist reaches the minimum player count, the request pin is updated to reflect 2 copies needed.

- [ ] Fill a game to max players, then click **Join Waitlist** — confirm added to waitlist section
- [ ] Click **Join Waitlist** when already on waitlist — confirm "You're already on the waitlist" error
- [ ] Click **Join Waitlist** when a seat is still available — confirm "There's still an open seat" error
- [ ] Add enough players to the waitlist to reach the minimum player count — confirm request pin updates to show "2 copies"
- [ ] Click **Leave Waitlist** — confirm removed from waitlist
- [ ] Dropping below min players on waitlist — confirm request pin reverts to "1 copy"

### 3f. Bring Confirm / Cancel

**What it does:** After adding a game via BGG or manual entry, the bot asks if you're bringing the game. Confirming adds it to your library.

- [ ] After suggesting a BGG game, click **Yes, I'll bring it** — confirm game is added to your library (check with `/library mine`)
- [ ] Click **No** — confirm the game is still in the lineup but not added to your library

---

## 4. `/library` — Game Library

### 4a. `/library add`

**What it does:** Adds a game you own to the shared library. Follows a priority order: checks your own library, then the group library, then the BGG catalog. When BGG finds an exact match, shows a confirm prompt before adding so the user can verify it's the right game. If confirmed, BGG details are loaded automatically and no "add details" modal appears.

#### Basic add — already owned
- [ ] `/library add game:Wingspan` when you already own it — confirm "already in your library" duplicate message
- [ ] Case-insensitive: `/library add game:wingspan` when you own "Wingspan" — same duplicate message

#### Others already own the game
- [ ] When another user owns the game (exact name match), confirm "already in the group library — adding your copy?" prompt with **Yes, add my copy** and **Cancel** buttons
- [ ] Click **Yes, add my copy** — confirm game is added

#### Partial match in group library
- [ ] `/library add game:wing` when "Wingspan" is in the group library — confirm a "similar games in the group library" select menu appears
- [ ] Select a match — confirm "adding your copy?" flow
- [ ] Select "None of these — search BGG" — confirm BGG catalog search continues

#### BGG exact match (confirm prompt)
- [ ] `/library add game:Wingspan` on an empty library — confirm a "Found **Wingspan** on BGG — is that the game?" confirm prompt appears with **Yes** and **No** buttons (game is NOT added yet)
- [ ] Click **Yes** — confirm game is added with BGG details (players, play time, weight, tags); no "add details" modal appears
- [ ] Click **No** — confirm BGG is dismissed and the "add details" modal appears for custom entry

#### BGG multiple matches (select UI)
- [ ] `/library add game:arkham` — confirm a "which did you mean?" select menu appears listing matches such as Arkham Horror and Arkham Horror: The Card Game
- [ ] Select a game from the dropdown — confirm "Found **X** on BGG — is that the game?" confirm prompt appears
- [ ] Confirm **Yes** — confirm game is added with BGG details, no modal

#### Single BGG partial match (confirm/dismiss)
- [ ] Type a name that produces exactly one token match that differs from the typed name (e.g. `wingsspan`) — confirm a "Found **Wingspan** on BGG" single-match confirm appears
- [ ] Click **Yes** — confirm added with BGG details
- [ ] Click **No, add as typed** — confirm added under the original typed name with the "add details" modal

#### No matches anywhere — custom game
- [ ] `/library add game:My Custom Game` with nothing matching in library or BGG catalog — confirm game is added immediately and the "add details" modal appears

### 4b. `/library remove`

**What it does:** Removes one of your games from the library. Supports fuzzy/partial name matching — if the exact name isn't found, shows a select menu of similar games you own.

- [ ] `/library remove game:Catan` (exact match) — confirm "Removed **Catan** from your library"
- [ ] `/library remove game:cat` (partial match for "Catan") — confirm a select menu of matching games appears
- [ ] `/library remove game:rooty` (partial reverse match — input contains the game name "Root") — confirm "Root" appears in the select menu
- [ ] Select a game from the partial match menu — confirm it is removed
- [ ] Select "None of these" from the partial match menu — confirm "No game removed" message
- [ ] Attempt to remove a game not in your library with no partial matches — confirm "not found" error

### 4c. `/library mine`

**What it does:** Lists all base games you've added to the library. Expansions imported via `/library import bgg` are excluded from this list (they appear in `/library view` under "Expansions in Library" instead).

- [ ] Run `/library mine` with games added — confirm all your base games are listed
- [ ] If you have imported BGG expansions — confirm they do NOT appear in `/library mine`
- [ ] Run `/library mine` with no games — confirm "You haven't added any games" message

### 4d. `/library list`

**What it does:** Shows all base games in the library grouped by game, with all owners listed. Expansions imported via `/library import bgg` are excluded. Games with complexity data show a colored dot (🟢 Light, 🟡 Medium, 🔴 Heavy) and a legend. Paginates with Previous/Next buttons when the library is large.

- [ ] Run `/library list` — confirm all library base games appear with owners
- [ ] If you have imported BGG expansions — confirm they do NOT appear in `/library list`
- [ ] Confirm games with complexity set show 🟢/🟡/🔴 icons before the name
- [ ] Confirm a legend appears at the bottom explaining icon colors
- [ ] Games without complexity data should appear without an icon
- [ ] Run with an empty library — confirm "No games in the library yet"
- [ ] With a large library (enough to span multiple pages):
  - [ ] Confirm **← Previous** and **Next →** buttons appear below the embed
  - [ ] **← Previous** is disabled on the first page
  - [ ] Click **Next →** — confirm page 2 is shown with a "Page 2 of N" footer
  - [ ] **Next →** is disabled on the last page
  - [ ] Click **← Previous** from page 2 — confirm you return to page 1
  - [ ] Run `/library list` again after the session expires — clicking navigation shows "This list has expired" message

### 4e. `/library view`

**What it does:** Shows full details for a specific game. Lazily enriches from BGG on first view (tags, expansions, weight, complexity, best player count). Complexity links to the matching Discord difficulty role. The "Expansions in Library" field shows only expansions that someone in the guild actually owns (imported via `/library import bgg`) with owner mentions.

- [ ] `/library view game:Root` (game with BGG data and owned expansions) — confirm embed shows:
  - Player range
  - Best With player count (if available)
  - Play time
  - Complexity with a clickable role mention (e.g. @Medium)
  - Tags
  - **Expansions in Library** — each owned expansion listed with owner mention (e.g. `Root: The Riverfolk Expansion — @snwns1`)
- [ ] `/library view game:Wingspan` where no expansions are in the guild library — confirm "Expansions in Library" field shows `*None in library*`
- [ ] `/library view game:Wingspan` where a game has no BGG expansion data at all — confirm no Expansions field appears
- [ ] View a game with no BGG data — confirm enrichment runs and data appears on second view
- [ ] View a game where you are an owner — confirm edit footer hint appears
- [ ] View a game that doesn't exist in the library — confirm "not found" message

### 4f. `/library edit`

**What it does:** Lets you update the details of a game you own (player count, play time, tags, expansions, and complexity).

- [ ] `/library edit game:Wingspan` — confirm the edit modal appears with five fields: Players, Play time, Tags, Expansions You Own, Complexity
- [ ] Update player range, save — confirm updated values appear in `/library view`
- [ ] Set Complexity to `Medium` — confirm 🟡 icon appears next to the game in `/library list`
- [ ] Set Complexity to `light` (lowercase) — confirm it is accepted and normalized to `Light`
- [ ] Set Complexity to an invalid value (e.g. `Extreme`) — confirm a warning is shown and the previous value is kept
- [ ] Leave Complexity blank — confirm existing complexity is preserved
- [ ] Attempt to edit a game you don't own — confirm permission error

### 4g. `/library clear`

**What it does:** Removes all games you've added in one action.

- [ ] Run `/library clear` — confirm all your games are removed (verify with `/library mine`)
- [ ] Run with no games in your library — confirm appropriate message

### 4h. `/library request`

**What it does:** Requests a specific game be brought to an event. When run inside an event channel it targets that specific event; when run elsewhere it targets the soonest upcoming event. If the game has expansions in the guild library, shows a copy preference select before submitting. Appears in the event's request pin. When a game isn't in the library, the BGG catalog is used to improve the error message.

#### Basic request (no expansions in library)
- [ ] `/library request game:Catan` from a non-event channel — confirm request targets the **soonest** upcoming event and the public confirmation names that event's date and the owner(s)
- [ ] `/library request game:Catan` from **inside** a specific event channel — confirm request targets **that event**, not the nearest one
- [ ] Request the same game twice for the same event — confirm duplicate is blocked
- [ ] Request with a slight punctuation variant (e.g. `Wonderlands War` when library has `Wonderland's War`) — confirm the partial-match picker appears
- [ ] Request a game that exists in the BGG catalog but isn't in the library — confirm error message says "isn't in the group library yet — ask someone who owns it to add it with `/library add`"
- [ ] None of the game's owners are RSVP'd to the event — confirm "None of the owners are attending" error

#### Request with expansion copy select
- [ ] Request a game where at least one attending owner has expansions in the guild library (imported via `/library import bgg`) — confirm an **ephemeral** "Which copy would you like?" select appears with:
  - One option per attending owner: `{DisplayName}'s copy` with description listing their expansions (or "Base game only" if they have none)
  - `Bot decides` option with description "Spread game-bringing load evenly among attending owners"
- [ ] Select a specific owner's copy — confirm the public announcement includes "— bringing: @owner"
- [ ] Select **Bot decides** — confirm the bot assigns the owner with fewest confirmed bring assignments for that event; public announcement shows that owner
- [ ] With multiple attending owners who have identical expansion sets — confirm **Bot decides** picks the one with fewer brings already confirmed
- [ ] Request a game where attending owners own the base game but NONE have expansions in the library — confirm the copy select does NOT appear; request goes through immediately

### 4i. `/library unrequest`

**What it does:** Cancels your game request for an event.

- [ ] `/library unrequest game:Catan` — confirm request is removed from the pin
- [ ] Attempt to unrequest a game you didn't request — confirm error

### 4j. `/library bring`

**What it does:** Shows which of your library games have been requested for upcoming events. Only shows requests where you are the preferred owner (or where no preference was set). When run with `game:<name>`, confirms you're bringing that game and shows which expansions to include — it marks the request with ✅ in the request pin.

#### Viewing requested games
- [ ] Add a game to your library, have another user request it via `/library request` (selecting your copy)
- [ ] Run `/library bring` — confirm the requested game appears in the list
- [ ] If you own expansions for the game — confirm they appear in the list entry (e.g. `• **Root** (with Riverfolk Expansion, Clockwork Expansion)`)
- [ ] If another owner was selected as the preferred owner — confirm the game does NOT appear in your bring list
- [ ] Run `/library bring` when none of your games are requested — confirm "None of your games have been requested" message
- [ ] Run `/library bring` inside a specific event channel — confirm only requests for that event are shown
- [ ] Run `/library bring` outside an event channel — confirm requests are grouped across all upcoming events

#### Confirming you're bringing a game
- [ ] Run `/library bring game:Root` (where Root is in your library, has been requested with your copy preferred, and you own expansions) — confirm success message includes expansion list (e.g. `✅ Got it — you're confirmed to bring **Root** (with Riverfolk Expansion) to the event on [date]!`)
- [ ] Run `/library bring game:Wingspan` (no expansions in library) — confirm standard success message with no expansion note
- [ ] Click Confirm — confirm the request pin in the event channel now shows ✅ next to the game name
- [ ] Run `/library bring game:Wingspan` when the game hasn't been requested — confirm "That game hasn't been requested" error
- [ ] Run `/library bring game:Wingspan` when Wingspan is NOT in your library — confirm "You don't own that game" error

### 4k. `/library import`

#### `/library import bgg`

**What it does:** Imports all owned games AND expansions from your linked BoardGameGeek collection. Base games are added as regular library entries. Expansions are added with an `isExpansion` flag — they appear in `/library view` under "Expansions in Library" but are excluded from `/library list` and `/library mine`. Requires a linked BGG account (`/bgg link`).

- [ ] Run `/library import bgg` without a linked BGG account — confirm "You don't have a BoardGameGeek account linked" error
- [ ] Run `/library import bgg` with a linked account — confirm:
  - Progress message "Fetching your BoardGameGeek collection…" appears
  - On success: "BoardGameGeek import complete — **X** games added, **Y** expansions added, **Z** already in your library"
  - Games from your BGG "owned" collection are added to the library
  - Expansions from your BGG collection are also added (if any are marked as owned)
- [ ] After import, run `/library mine` — confirm only base games appear, not expansions
- [ ] After import, run `/library list` — confirm only base games appear
- [ ] After import, run `/library view game:Root` (or another game with owned expansions) — confirm "Expansions in Library" shows your imported expansions with your mention
- [ ] Run `/library import bgg` a second time — confirm all entries show as "already in your library" (no duplicates)

#### `/library import csv` (Admin only)

**What it does:** Bulk-imports games from a CSV file. Reads columns: game name, owner Discord ID, BGG ID, player counts, play time, BGG best players (`bggbestplayers`), and weight (`avgweight`).

- [ ] Run `/library import csv` with a valid CSV — confirm games are added to the library
- [ ] Confirm `bestPlayers` is populated from the `bggbestplayers` column
- [ ] Confirm `complexity` is derived from the `avgweight` column (≤2.0 = Light, ≤3.5 = Medium, >3.5 = Heavy)
- [ ] Run with malformed CSV — confirm appropriate error message
- [ ] Confirm non-admin gets a permission error

### 4l. `/library search`

**What it does:** Searches the library with filters. Results are sorted by proximity to the searched player count (using BGG best-at data), or alphabetically if no player count is given. Footer always states the sort method.

#### Player count filter
- [ ] `/library search players:4` — confirm results include games supporting 4 players
- [ ] Confirm results are sorted by "best at" player count proximity, with `best: Xp` in each result's meta line
- [ ] Footer shows "Sorted by closest to 4 players (by best player count)"
- [ ] `/library search players:2,4` — confirm multi-value search (comma-separated) works
- [ ] A game best at 6 but supporting 2–6 should appear lower than a game best at 2 or 4

#### Tag filter
- [ ] `/library search tag:Co-op` — confirm only Co-op tagged games appear
- [ ] `/library search tag:Co-op tag2:Deck Building` — confirm OR logic (games matching either tag appear)
- [ ] Add a third tag with `tag3` — confirm OR logic across all three

#### Duration filter
- [ ] `/library search duration:60` — confirm games within ±15 min of 60 minutes appear
- [ ] Footer or result note mentions ±15 min fuzzy range was applied
- [ ] `/library search min_duration:30 max_duration:90` — confirm only games in that exact range appear
- [ ] `/library search min_duration:60` — confirm only games 60 min or longer appear

#### Complexity filter
- [ ] `/library search complexity:Light` — confirm only Light games appear
- [ ] `/library search complexity:Medium` and `complexity:Heavy` — same check

#### Combined filters
- [ ] Combine player count + tag + duration — confirm all filters apply together
- [ ] Search with no matches — confirm "No games matched your filters"

#### Sort and result display
- [ ] Run a search without player count — confirm footer says "Sorted alphabetically"
- [ ] Run a search with player count — confirm footer says "Sorted by closest to X players (by best player count)"
- [ ] Trigger truncation by searching with very broad filters — confirm footer adds "Add more filters to narrow results"

### 4m. `/library random`

**What it does:** Picks 3 random games from the library, optionally filtered by tags and complexity.

- [ ] `/library random` with no filters — confirm 3 random games are shown
- [ ] `/library random tag:Co-op` — confirm all 3 results are Co-op tagged
- [ ] `/library random complexity:Light` — confirm all results are Light complexity
- [ ] `/library random tag:Strategy tag2:Economic` — confirm OR logic works
- [ ] Run multiple times — confirm different results each time (Fisher-Yates shuffle)
- [ ] Run with filters that match fewer than 3 games — confirm fewer than 3 results are shown

---

## 5. `/myroles` — Game Preferences

**What it does:** A 2-step interactive flow for members to set their difficulty preference and up to 5 genre tags. Roles are updated on Save.

### Prerequisites
- [ ] At least one game tag must exist (run `/gametags sync` first)

### Test Cases

- [ ] Run `/myroles` — confirm Step 1 (difficulty) embed appears with difficulty buttons
- [ ] Click a difficulty button (e.g. Light) — confirm it highlights in green and updates the embed
- [ ] Click the same difficulty again — confirm it deselects (toggle behavior)
- [ ] Click a different difficulty — confirm the previous one deselects (only one difficulty allowed at a time)
- [ ] Click **Next: Pick Genres →** — confirm Step 2 (genre) embed appears showing your difficulty selection
- [ ] Click **← Difficulty** — confirm you return to Step 1 with selections intact
- [ ] Select up to 5 genre tags — confirm they highlight green
- [ ] Attempt to select a 6th genre — confirm the extra buttons are disabled and the label shows "limit reached"
- [ ] Deselect a genre — confirm other buttons become active again
- [ ] If tags span multiple pages — confirm **Next →** and **← Back** pagination buttons appear
- [ ] Navigate pages and select tags from different pages — confirm all selections are retained
- [ ] Click **Save** — confirm:
  - A "Game Preferences Saved!" embed appears showing selected difficulty and genres
  - Member's roles in the server are updated accordingly
- [ ] Run `/myroles` again after saving — confirm existing roles are pre-selected

---

## 6. `/gametags` — Tag Management (Admin only)

**What it does:** Admins manage the library of game genre and difficulty tags, which also creates corresponding Discord roles.

- [ ] Confirm all `/gametags` subcommands return "Only admins can manage game tags" for non-admins

### 6a. `/gametags add`
- [ ] `/gametags add name:Puzzle` — confirm Discord role is created and tag is saved
- [ ] `/gametags add name:Puzzle color:Red` — confirm role is created with the selected color
- [ ] `/gametags add name:Hard type:Difficulty` — confirm role is created with `difficulty` type
- [ ] Add a tag with a duplicate name — confirm "already exists" error
- [ ] Color autocomplete: typing in the color field should show a list of named colors

### 6b. `/gametags remove`
- [ ] `/gametags remove name:Puzzle` — confirm Discord role is deleted and tag is removed
- [ ] Attempt to remove a non-existent tag — confirm "No tag named X found" error

### 6c. `/gametags list`
- [ ] Run `/gametags list` — confirm all tags appear grouped by Difficulty and Genre
- [ ] Run with no tags set up — confirm "No game tags set up yet"

### 6d. `/gametags sync`
- [ ] Run `/gametags sync` on a fresh server — confirm all built-in genre tags and 3 difficulty roles (Light, Medium, Heavy) are created
- [ ] Run again — confirm "already existed" for all tags and no duplicates are created
- [ ] Partially remove some tags, then sync — confirm only the missing ones are re-created

### 6e. `/gametags clear`
- [ ] Run `/gametags clear` — confirm all tag roles are deleted from Discord and the tag list is cleared
- [ ] Run with no tags set up — confirm "No game tags to remove"

---

## 7. `/welcome` — Welcome Message (Admin only)

**What it does:** Sends a welcome DM and a channel message when new members join. Admins can configure the channel, rules link, and Facebook URL.

- [ ] Confirm all `/welcome` subcommands return a permission error for non-admins

### 7a. `/welcome config`
- [ ] Run with no options — confirm current config is displayed
- [ ] Set channel: `/welcome config channel:#welcome`
- [ ] Set rules channel: `/welcome config rules_channel:#rules`
- [ ] Set Facebook URL: `/welcome config facebook_url:https://facebook.com/groups/...`
- [ ] Confirm all three values persist after setting them

### 7b. `/welcome test`
- [ ] Run `/welcome test` — confirm:
  - Welcome message appears in the configured welcome channel
  - A DM is sent to you with the welcome message
  - Message includes a link to the rules channel and Facebook group (if configured)

### 7c. `/welcome greet`
- [ ] `/welcome greet member:@SomeUser` — confirm the welcome message is sent to that user's DMs and posted in the welcome channel

### 7d. Automatic Welcome (New Member Join)
- [ ] Have a user join the server — confirm the welcome message is automatically sent to the welcome channel and to the new member via DM

---

## 8. `/bgg` — BGG Account Linking

**What it does:** Lets members link their BoardGameGeek username to their account on this server. The username is validated against the BGG API before saving. No password is stored.

### 8a. `/bgg link`
- [ ] Run `/bgg link username:validuser` — confirm BGG API validates the account and a success embed appears showing the linked username with a BGG profile link and "Powered by BGG" footer
- [ ] Run `/bgg link username:nonexistentuser` — confirm "We couldn't verify that BoardGameGeek account" message
- [ ] Run `/bgg link` with the same username already linked — confirm "already linked" message with no API call made
- [ ] Run `/bgg link` twice rapidly with a different username — confirm cooldown message with seconds remaining on second attempt
- [ ] Run `/bgg link` twice with different valid usernames — confirm the second link shows "BoardGameGeek Account Updated" with old → new username
- [ ] Simulate BGG being unreachable — confirm "We couldn't verify that BoardGameGeek account" message

### 8b. `/bgg unlink`
- [ ] Run `/bgg unlink` after linking — confirm account is removed and success message shown
- [ ] Run `/bgg unlink` with no account linked — confirm "You don't have a BGG account linked" message

### 8c. `/bgg profile`
- [ ] Run `/bgg profile` after linking — confirm embed shows linked username, BGG profile link, linked date, and "Powered by BGG" footer
- [ ] Run `/bgg profile` with no account linked — confirm "You don't have a BGG account linked" message with hint to use `/bgg link`

---

## 9. Edge Cases and Error Handling

- [ ] Run any command in a DM (outside a server) — confirm graceful failure
- [ ] Run `/game suggest` in a channel with no active event and no upcoming events — confirm "There are no upcoming events" message
- [ ] Attempt to RSVP to a cancelled event — confirm the embed is removed or no longer responds
- [ ] Suggest a game when the event's channel has been archived — confirm "no longer active" message
- [ ] Verify bot handles BGG being unreachable — confirm that if the local BGG catalog has matches, a catalog-sourced select menu appears instead of going straight to manual entry; if no catalog match, manual entry fallback appears
- [ ] Confirm all ephemeral responses are only visible to the invoking user
