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

**What it does:** Adds a game you own to the shared library.

- [ ] `/library add game:Catan` — confirm "added to your library"
- [ ] Add the same game again — confirm "already in your library" duplicate message
- [ ] Add a game with a BGG ID option (if implemented)

### 4b. `/library remove`

**What it does:** Removes one of your games from the library.

- [ ] `/library remove game:Catan` — confirm "removed from your library"
- [ ] Attempt to remove a game not in your library — confirm "not found" error

### 4c. `/library mine`

**What it does:** Lists all games you've added to the library.

- [ ] Run `/library mine` with games added — confirm all your games are listed
- [ ] Run `/library mine` with no games — confirm "You haven't added any games" message

### 4d. `/library list`

**What it does:** Shows the full library grouped by game, with all owners listed. Games with complexity data show a colored dot (🟢 Light, 🟡 Medium, 🔴 Heavy) and a legend. Paginates with Previous/Next buttons when the library is large.

- [ ] Run `/library list` — confirm all library games appear with owners
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

**What it does:** Shows full details for a specific game. Lazily enriches from BGG on first view (tags, expansions, weight, complexity, best player count). Complexity links to the matching Discord difficulty role.

- [ ] `/library view game:Wingspan` — confirm embed shows:
  - Player range (e.g. 1–5)
  - Best With player count (if available)
  - Play time
  - Complexity with a clickable role mention (e.g. @Medium)
  - Tags
  - BGG Expansions
  - Owners
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

**What it does:** Requests a specific game be brought to an event. When run inside an event channel it targets that specific event; when run elsewhere it targets the soonest upcoming event. Appears in the event's request pin.

- [ ] `/library request game:Catan` from a non-event channel — confirm request targets the **soonest** upcoming event and the confirmation message names that event's date
- [ ] `/library request game:Catan` from **inside** a specific event channel (e.g. June 29) — confirm request targets **that event**, not the nearest one
- [ ] Request the same game twice for the same event — confirm duplicate is blocked and error message names the event date
- [ ] Request with a slight punctuation variant (e.g. `Wonderlands War` when the library has `Wonderland's War`) — confirm the partial-match picker appears with the correct game listed

### 4i. `/library unrequest`

**What it does:** Cancels your game request for an event.

- [ ] `/library unrequest game:Catan` — confirm request is removed from the pin
- [ ] Attempt to unrequest a game you didn't request — confirm error

### 4j. `/library bring`

**What it does:** Shows which of your library games have been requested for upcoming events. When run with `game:<name>`, confirms you're bringing that game — it marks the request with ✅ in the request pin.

#### Viewing requested games
- [ ] Add a game to your library, have another user request it via `/library request`
- [ ] Run `/library bring` — confirm the requested game appears in the list
- [ ] Run `/library bring` when none of your games are requested — confirm "None of your games have been requested" message
- [ ] Run `/library bring` inside a specific event channel — confirm only requests for that event are shown
- [ ] Run `/library bring` outside an event channel — confirm requests are grouped across all upcoming events

#### Confirming you're bringing a game
- [ ] Run `/library bring game:Wingspan` (where Wingspan is in your library and has been requested) — confirm you see the game details and a "Confirm" button
- [ ] Click Confirm — confirm the request pin in the event channel now shows ✅ next to the game name
- [ ] Run `/library bring game:Wingspan` when the game hasn't been requested — confirm "That game hasn't been requested" error
- [ ] Run `/library bring game:Wingspan` when Wingspan is NOT in your library — confirm "You don't own that game" error

### 4k. `/library import` (Admin only)

**What it does:** Bulk-imports games from a CSV file. Reads columns: game name, owner Discord ID, BGG ID, player counts, play time, BGG best players (`bggbestplayers`), and weight (`avgweight`).

- [ ] Run `/library import` with a valid CSV — confirm games are added to the library
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

## 8. Edge Cases and Error Handling

- [ ] Run any command in a DM (outside a server) — confirm graceful failure
- [ ] Run `/game suggest` in a channel with no active event and no upcoming events — confirm "There are no upcoming events" message
- [ ] Attempt to RSVP to a cancelled event — confirm the embed is removed or no longer responds
- [ ] Suggest a game when the event's channel has been archived — confirm "no longer active" message
- [ ] Verify bot handles BGG being unreachable — confirm manual entry fallback message appears instead of crashing
- [ ] Confirm all ephemeral responses are only visible to the invoking user
