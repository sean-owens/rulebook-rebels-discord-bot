# Rulebook Rebels Bot — Testing Guide

This document describes every feature in the bot and provides a checklist of test cases to verify correct behavior. All tests are performed in Discord using slash commands unless otherwise noted.

---

## Prerequisites

---

## 1. `/help`

**What it does:** Displays an ephemeral embed listing all available commands. Shows a Host section to members with Manage Events permission. Shows an Admin section to members with Manage Guild permission. Admins see all three sections.

- [ ] Run `/help` as a regular member — confirm only user-facing command sections appear (`/event`, `/game`, `/library`, `/myroles`, `/bgg`) with **no Host or Admin section**
- [ ] Run `/help` as a host — confirm the **🎙️ /host** section appears in addition to user commands, but **no Admin section**
- [ ] Run `/help` as an admin — confirm all three sections appear: user commands, **🎙️ /host**, and **🔧 /admin**
- [ ] Confirm `/game cancel` description says "Remove your own game suggestion"
- [ ] Confirm `/library clear` description says "Remove all your own games at once"
- [ ] Confirm all responses are ephemeral

---

## 2. `/event` — Event Viewing

### 2a. `/event list`

**What it does:** Lists all upcoming (non-cancelled, non-archived) game nights with IDs, dates, times, and RSVP counts.

- [ ] With at least one active event — confirm it shows the event with its ID and details
- [ ] With no active events — confirm it shows "No upcoming game nights scheduled"
- [ ] Confirm the response is ephemeral

### 2b. Automatic Archiving (Event Completion)

**What it does:** When a Discord scheduled event is marked as "Completed" by the server, the bot automatically archives the associated channel.

- [ ] Mark a test event as completed in Discord — confirm:
  - Event channel moves to Archive category
  - Lock-date message is posted in the channel
  - Channel remains writable for 7 days

### 2c. Delayed Channel Lock

**What it does:** 7 days after archiving, the bot locks the channel by setting `SendMessages: false` for everyone.

- [ ] Check `gamenights.json` for a record with `archived: true` and a `lockAt` date — confirm `locked` is not yet set
- [ ] After the `lockAt` date passes (or manually set `lockAt` to a past date and restart the bot) — confirm:
  - Bot sets `SendMessages: false` on the channel
  - Message posted: "This channel is now read-only"
  - Members can no longer post in the channel
  - `locked: true` is saved to `gamenights.json`
- [ ] Restart the bot with a past-due `lockAt` record — confirm the lock is applied on startup without waiting for the hourly check

### 2d. RSVP Buttons

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

**What it does:** Removes your own game suggestion from the lineup. Only the person who suggested the game can remove it via this command; hosts can remove any game via `/host game cancel`.

- [ ] Remove your own game suggestion: `/game cancel title:Wingspan` — confirm card is deleted
- [ ] Attempt to remove another user's suggestion as a regular member — confirm "Only the person who suggested... can remove it. Ask a host or admin if you need it removed." error
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

**What it does:** Adds a game you own to the shared library. Follows a priority order: checks your own library, then the group library, then the BGG catalog. When BGG finds an exact match, shows a confirm prompt before adding so the user can verify it's the right game.

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
- [ ] `/library add game:Wingspan` on an empty library — confirm a "Found **Wingspan** on BGG — is that the game?" confirm prompt appears
- [ ] Click **Yes** — confirm game is added with BGG details; no "add details" modal appears
- [ ] Click **No** — confirm BGG is dismissed and the "add details" modal appears for custom entry

#### BGG multiple matches (select UI)
- [ ] `/library add game:arkham` — confirm a "which did you mean?" select menu appears
- [ ] Select a game from the dropdown — confirm the BGG confirm prompt appears
- [ ] Confirm **Yes** — confirm game is added with BGG details

#### No matches anywhere — custom game
- [ ] `/library add game:My Custom Game` with nothing matching anywhere — confirm game is added immediately and the "add details" modal appears

### 4b. `/library remove`

**What it does:** Removes one of your games from the library. Supports fuzzy/partial name matching.

- [ ] `/library remove game:Catan` (exact match) — confirm "Removed **Catan** from your library"
- [ ] `/library remove game:cat` (partial match for "Catan") — confirm a select menu of matching games appears
- [ ] Select a game from the partial match menu — confirm it is removed
- [ ] Attempt to remove a game not in your library — confirm "not found" error

### 4c. `/library mine`

**What it does:** Lists all base games you've added to the library. Expansions imported via `/library import bgg` are excluded.

- [ ] Run `/library mine` with games added — confirm all your base games are listed
- [ ] If you have imported BGG expansions — confirm they do NOT appear in `/library mine`
- [ ] Run `/library mine` with no games — confirm "You haven't added any games" message

### 4d. `/library list`

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

### 4e. `/library view`

**What it does:** Shows full details for a specific game. Lazily enriches from BGG on first view (tags, expansions, weight, complexity, best player count, how-to-play video, thumbnail).

- [ ] `/library view game:Root` — confirm embed shows player range, best player count, play time, complexity with role mention, tags, Resources field (how-to-play link + BGG files link), thumbnail in top-right, and Powered by BGG logo
- [ ] View a game with no BGG data — confirm enrichment runs and data appears
- [ ] View a game where you are an owner — confirm edit footer hint appears
- [ ] View a game that doesn't exist — confirm "not found" message

### 4f. `/library edit`

**What it does:** Lets you update the details of a game you own (player count, play time, tags, expansions, and complexity).

- [ ] `/library edit game:Wingspan` — confirm the edit modal appears
- [ ] Update player range, save — confirm updated values appear in `/library view`
- [ ] Set Complexity to `Medium` — confirm 🟡 icon appears in `/library list`
- [ ] Set Complexity to `light` (lowercase) — confirm it is accepted and normalized to `Light`
- [ ] Set Complexity to an invalid value (e.g. `Extreme`) — confirm a warning is shown and the previous value is kept
- [ ] Attempt to edit a game you don't own — confirm permission error

### 4g. `/library clear`

**What it does:** Removes all of your own games from the library. Self-only — cannot target another user. Admins can clear another user's library via `/admin library clear`.

- [ ] Run `/library clear` — confirm all your own games are removed (verify with `/library mine`)
- [ ] Run with no games in your library — confirm "You have no games in the library to remove"
- [ ] Confirm a regular user cannot clear another user's library via this command

### 4h. `/library request`

**What it does:** Requests a specific game be brought to an event.

#### Basic request (no expansions in library)
- [ ] `/library request game:Catan` from a non-event channel — confirm request targets the soonest upcoming event
- [ ] `/library request game:Catan` from inside a specific event channel — confirm request targets that event
- [ ] Request the same game twice — confirm duplicate is blocked
- [ ] None of the game's owners are RSVP'd — confirm "None of the owners are attending" error

#### Request with expansion copy select
- [ ] Request a game where at least one attending owner has expansions — confirm "Which copy would you like?" select appears
- [ ] Select a specific owner's copy — confirm announcement includes "— bringing: @owner"
- [ ] Select **Bot decides** — confirm the bot assigns the owner with fewest confirmed brings

### 4i. `/library unrequest`

**What it does:** Cancels your own game requests for an event. Self-only — shows only your own requests. Hosts can remove any request via `/host library unrequest`.

- [ ] Run `/library unrequest` inside an event channel — confirm only your own requests appear in the select menu
- [ ] Select a request and remove it — confirm it disappears from the request pin
- [ ] Run `/library unrequest` with no personal requests — confirm "You haven't requested any games for this event"
- [ ] Run from outside an event channel — confirm event picker appears; selecting an event shows your requests for that event only
- [ ] Confirm regular users cannot see or remove other users' requests via this command

### 4j. `/library bring`

**What it does:** Shows which of your library games have been requested for upcoming events, or confirms you're bringing a game.

- [ ] Run `/library bring` — confirm only your games that have been requested appear
- [ ] Run `/library bring game:Root` (where Root is requested with your copy preferred) — confirm success message with expansion list
- [ ] Click Confirm — confirm ✅ appears next to the game in the event's request pin
- [ ] Run with a game that hasn't been requested — confirm "That game hasn't been requested" error

### 4k. `/library import`

#### `/library import bgg`

**What it does:** Imports all owned games and expansions from your linked BoardGameGeek collection.

- [ ] Run without a linked BGG account — confirm "You don't have a BoardGameGeek account linked" error
- [ ] Run with a linked account — confirm success message with game/expansion counts
- [ ] Run a second time — confirm all entries show as "already in your library" (no duplicates)

#### `/library import csv`

**What it does:** Bulk-imports games from a CSV file. Available to any server member.

- [ ] Run `/library import csv` with a valid CSV — confirm games are added
- [ ] Run with malformed CSV — confirm appropriate error message

### 4l. `/library search`

**What it does:** Searches the library with filters for player count, tags, duration, and complexity.

- [ ] `/library search players:4` — confirm results include games supporting 4 players, sorted by proximity to 4
- [ ] `/library search tag:Co-op` — confirm only Co-op tagged games appear
- [ ] `/library search complexity:Light` — confirm only Light games appear
- [ ] Combine filters — confirm all filters apply together
- [ ] Search with no matches — confirm "No games matched your filters"

### 4m. `/library random`

**What it does:** Picks 3 random games from the library, optionally filtered by tags and complexity.

- [ ] `/library random` with no filters — confirm 3 random games are shown
- [ ] `/library random tag:Co-op` — confirm all 3 results are Co-op tagged
- [ ] Run multiple times — confirm different results each time

---

## 5. `/myroles` — Game Preferences

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

---

## 6. `/bgg` — BGG Account Linking

**What it does:** Lets members link their BoardGameGeek username to their Discord account on this server.

### 6a. `/bgg link`
- [ ] Run `/bgg link username:validuser` — confirm BGG API validates and success embed appears with "Powered by BGG" logo
- [ ] Run `/bgg link username:nonexistentuser` — confirm "We couldn't verify that BoardGameGeek account" message
- [ ] Run with same username already linked — confirm "already linked" message

### 6b. `/bgg unlink`
- [ ] Run after linking — confirm account is removed
- [ ] Run with no account linked — confirm "You don't have a BGG account linked" message

### 6c. `/bgg profile`
- [ ] Run after linking — confirm embed shows linked username, BGG profile link, and linked date
- [ ] Run with no account linked — confirm helpful error with hint to use `/bgg link`

---

## 7. `/host` — Host Commands (Manage Events permission required)

**What it does:** Provides elevated event and moderation commands to members with the Host role (or Manage Events permission). Non-hosts should not see these commands in the Discord command picker.

- [ ] Confirm `/host` commands are **not visible** in the command picker for regular members
- [ ] Confirm `/host` commands **are visible** for members with the Host or Admin role

### 7a. `/host event create`

**What it does:** Creates a Discord scheduled event, a text channel, and posts an RSVP embed in the configured announcements channel.

- [ ] Create an event with required fields only: `/host event create date:August 22 time:7pm` — confirm:
  - Discord scheduled event is created
  - A channel named `monthly-august-22` appears under "Monthly Events"
  - RSVP embed is posted in the announcements channel
- [ ] Create an event with all fields (end_time, location, link, description) — confirm all appear in the embed
- [ ] Confirm date formats work: `aug 22`, `August 22`, `august 22, 2026`
- [ ] Confirm time formats work: `7pm`, `7:00 PM`, `19:00`

### 7b. `/host event cancel`

**What it does:** Cancels a game night, deletes the Discord scheduled event, removes the RSVP embed, and cleans up the event channel.

- [ ] Cancel an event as the creator: `/host event cancel id:<event-id>` — confirm event is removed
- [ ] Cancel an event as a host (non-creator) — confirm it works
- [ ] Attempt to cancel with an invalid ID — confirm "No event found" error
- [ ] Attempt to cancel an already-cancelled event — confirm "already cancelled" error

### 7c. `/host event archive`

**What it does:** Manually archives channels for all past events that haven't been archived yet.

- [ ] Run `/host event archive` with no past events — confirm "No past event channels to archive"
- [ ] Run with a past event — confirm channel moves to "Archive" category and a lock-date message is posted

### 7d. `/host game cancel`

**What it does:** Removes any game from the event lineup regardless of who suggested it.

- [ ] Remove another user's game: `/host game cancel title:Wingspan` — confirm card is deleted
- [ ] Attempt to cancel a game not in the lineup — confirm "No game called X found" error

### 7e. `/host library unrequest`

**What it does:** Shows all game requests for an event (not just the host's own) and allows removing any of them.

- [ ] Run inside an event channel — confirm ALL game requests appear (not just yours)
- [ ] Remove another user's request — confirm it disappears from the request pin
- [ ] Run with no requests — confirm "No games have been requested for this event"
- [ ] Run from outside an event channel — confirm event picker appears; selecting an event shows all requests

---

## 8. `/admin` — Admin Commands (Manage Guild permission required)

**What it does:** Provides server configuration commands to members with the Admin role (or Manage Guild permission). Non-admins should not see these commands in the Discord command picker.

- [ ] Confirm `/admin` commands are **not visible** in the command picker for regular members and hosts
- [ ] Confirm `/admin` commands **are visible** for members with the Admin role

### 8a. `/admin event config`

**What it does:** Sets server-wide defaults used when hosts create new events.

- [ ] Run `/admin event config` with no options — confirm it shows current defaults
- [ ] Set a default location: `/admin event config location:Library Room 1` — confirm it saves
- [ ] Set a default start time: `/admin event config time:7:00 PM` — confirm it saves
- [ ] Set an announcements channel: `/admin event config announcements:#announcements` — confirm it saves
- [ ] Set open channels to true/false — confirm it saves and new events respect the setting
- [ ] Set event category and archive category — confirm new events and archives use the correct category

### 8b. `/admin library clear`

**What it does:** Clears all library entries for a specified server member. Admin-only — use for moderation or cleanup.

- [ ] Run `/admin library clear user:@SomeMember` — confirm all their games are removed
- [ ] Run for a user with no library entries — confirm appropriate message

### 8c. `/admin library sync`

**What it does:** Force re-fetches a game's data from BoardGameGeek, overwriting cached BGG fields (thumbnail, how-to-play video, expansions, best player count).

- [ ] Run `/admin library sync game:Wingspan` — confirm updated embed shows with "✅ synced from BoardGameGeek" message
- [ ] Run with a game name that doesn't exist in the library — confirm "not found" error with partial match suggestions
- [ ] Run for a game with no BGG ID — confirm "no BGG ID — nothing to sync" error

### 8d. `/admin tags add`

**What it does:** Creates a new game genre or difficulty tag and its corresponding Discord role.

- [ ] `/admin tags add name:Puzzle` — confirm Discord role is created and tag is saved
- [ ] `/admin tags add name:Puzzle color:Red` — confirm role is created with the selected color (use autocomplete)
- [ ] `/admin tags add name:Hard type:Difficulty` — confirm role is created with difficulty type
- [ ] Add a tag with a duplicate name — confirm "already exists" error

### 8e. `/admin tags remove`

**What it does:** Deletes a game tag and its Discord role.

- [ ] `/admin tags remove name:Puzzle` — confirm Discord role is deleted and tag is removed
- [ ] Attempt to remove a non-existent tag — confirm "No tag named X found. Use `/admin tags list`" error

### 8f. `/admin tags list`

**What it does:** Lists all current game genre and difficulty tags.

- [ ] Run `/admin tags list` — confirm all tags appear grouped by Difficulty and Genre
- [ ] Run with no tags set up — confirm "No game tags set up yet"

### 8g. `/admin tags sync`

**What it does:** Creates Discord roles for all built-in game tags and difficulty levels (skips any that already exist).

- [ ] Run `/admin tags sync` on a fresh server — confirm all built-in genre tags and difficulty roles (Light, Medium, Heavy) are created
- [ ] Run again — confirm "already existed" for all and no duplicates

### 8h. `/admin tags clear`

**What it does:** Removes all game tags and their Discord roles from the server.

- [ ] Run `/admin tags clear` — confirm all tag roles are deleted and the tag list is cleared
- [ ] Run with no tags set up — confirm "No game tags to remove"
- [ ] Confirm the action suggests using `/admin tags sync` to recreate them

### 8i. `/admin welcome config`

**What it does:** Sets the welcome channel, rules channel, and Facebook group URL for the automatic welcome message.

- [ ] Run with no options — confirm current config is displayed
- [ ] Set channel: `/admin welcome config channel:#welcome`
- [ ] Set rules channel: `/admin welcome config rules_channel:#rules`
- [ ] Set Facebook URL: `/admin welcome config facebook_url:https://facebook.com/groups/...`
- [ ] Confirm all three values persist after setting them

### 8j. `/admin welcome test`

**What it does:** Sends the welcome message to yourself as a preview.

- [ ] Run `/admin welcome test` — confirm welcome message appears in the welcome channel and a DM is sent

### 8k. `/admin welcome greet`

**What it does:** Manually sends the welcome message to a specific server member.

- [ ] `/admin welcome greet member:@SomeUser` — confirm welcome message is sent to that user's DMs and posted in the welcome channel

---

## 9. Server Setup — Auto Role Creation (`guildCreate`)

**What it does:** When the bot is added to a new server, it automatically creates two Discord roles — **Admin** (red, with ManageGuild/ManageEvents/ManageRoles/ManageMessages/ManageChannels) and **Host** (blue, with ManageEvents/ManageMessages) — so the server owner can immediately assign the right people without manually creating roles.

- [ ] Add the bot to a brand-new test server — confirm two roles appear: **Admin** (red) and **Host** (blue)
- [ ] Confirm the **Admin** role has at minimum: Manage Server, Manage Events, Manage Roles, Manage Messages, Manage Channels
- [ ] Confirm the **Host** role has at minimum: Manage Events, Manage Messages
- [ ] Check `bot.log` — confirm `[GuildCreate] Created "Admin" role in <server>` and `[GuildCreate] Created "Host" role in <server>` lines appear
- [ ] Remove the bot and re-add it to a server where the Admin and Host roles already exist — confirm `[GuildCreate] "Admin" role already exists — skipping` and same for Host; no duplicate roles created
- [ ] Assign the **Host** role to a test member — confirm they can see `/host` commands but not `/admin` commands
- [ ] Assign the **Admin** role to a test member — confirm they can see both `/admin` and `/host` commands

---

## 10. Automatic Welcome (New Member Join)

**What it does:** When a new member joins the server, the bot sends a welcome DM and posts a message in the configured welcome channel.

- [ ] Have a user join the server — confirm the welcome message is automatically sent to the welcome channel and to the new member via DM
- [ ] Confirm the message includes a link to the rules channel and Facebook group (if configured via `/admin welcome config`)

---

## 11. Edge Cases and Error Handling

- [ ] Run any command in a DM (outside a server) — confirm graceful failure
- [ ] Run `/game suggest` in a channel with no active event and no upcoming events — confirm "There are no upcoming events" message
- [ ] Attempt to RSVP to a cancelled event — confirm the embed is removed or no longer responds
- [ ] Suggest a game when the event's channel has been archived — confirm "no longer active" message
- [ ] Verify bot handles BGG being unreachable — confirm graceful fallback to local catalog or manual entry
- [ ] Confirm all ephemeral responses are only visible to the invoking user
