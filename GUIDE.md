# Rulebook Rebels Bot — User Guide

The Rulebook Rebels bot helps the group organize monthly game nights, manage a shared game library, and let members discover games they'll enjoy. Everything is controlled through slash commands (type `/` in any channel to see the available commands).

> This bot was built with the assistance of [Claude](https://claude.ai), Anthropic's AI assistant.

---

## Table of Contents

1. [Events](#events)
2. [Game Suggestions](#game-suggestions)
3. [Group Library](#group-library)
4. [Game Preferences (Roles)](#game-preferences-roles)
5. [Admin Commands](#admin-commands)
6. [Welcome System](#welcome-system)

---

## Events

The `/event` command is how game nights are created and managed.

---

### Viewing Upcoming Events

```
/event list
```

Shows all upcoming game nights — date, time, location, and how many people are going. Only visible to you.

---

### RSVPing to an Event

When an event is announced, an embed is posted in the announcements channel with three buttons:

| Button | What it does |
|---|---|
| **Going** | Confirms your attendance. Grants you access to the private event channel. |
| **Maybe** | Marks you as a maybe. Also grants access to the event channel. |
| **Can't Go** | Removes your RSVP if you previously said you were going. |

You can change your RSVP at any time before the event. RSVPs are also synced with the Discord scheduled event — marking yourself as "Interested" there counts as Going.

---

### Creating an Event *(any member)*

```
/event create date:<date> time:<time>
```

**Required:**
- `date` — The event date. Examples: `August 22`, `aug 22`, `September 5 2026`
- `time` — Start time. Examples: `7pm`, `7:00 PM`, `19:00`

**Optional:**
- `end_time` — End time. Uses the server default if omitted. Example: `10pm`
- `location` — Where the event is being held. Uses the server default if omitted.
- `link` — A URL for the location (map link, event page, etc.)
- `description` — Any extra notes for the event.

**What happens when you create an event:**
- A Discord scheduled event is created on the server.
- A private `Monthly Events` channel is created (e.g. `#monthly-august-22`).
- An RSVP embed is posted in the announcements channel with Going / Maybe / Can't Go buttons.
- The next upcoming event is pinned in the announcements channel automatically.

---

### Cancelling an Event *(creator or admin)*

```
/event cancel id:<event-id>
```

The event ID is shown in the footer of the RSVP embed. Use `/event list` to look it up.

Cancelling an event will:
- Delete the Discord scheduled event.
- Delete the event's private channel.
- Remove the RSVP post from the announcements channel.
- Update the pinned event post.

---

## Game Suggestions

Once an event is created, members can suggest games to play using `/game`. These commands work best inside the event's private channel, but can also be used from anywhere.

---

### Suggesting a Game

```
/game suggest title:<game name>
```

**Optional:**
- `with_expansions` — Set to `true` if you want to include expansions for this game.

**How the suggestion flow works:**

1. The bot first checks the group library for an exact match.
2. If no exact match, it checks for partial matches in the library and asks you to confirm which game you meant.
3. If the game isn't in the library, it searches [BoardGameGeek](https://boardgamegeek.com) and presents a list to pick from.
4. If you can't find it anywhere, you can enter the details manually (title, player count, duration, and an optional link).
5. After adding a game, you'll be asked to select genre tags and whether you're bringing the game. Both steps are optional.

> **Note:** If a game owner isn't attending the event (Going or Maybe), their games can't be suggested — they wouldn't have the copy available.

**If you use `/game suggest` outside an event channel**, the bot will ask you to pick which upcoming event you want to add the game to.

---

### Viewing the Game Lineup

```
/game list
```

Shows all games suggested for the current event channel, including player count, estimated play time, and how many seats are filled.

---

### Removing a Suggestion *(suggester or moderator)*

```
/game cancel title:<game name>
```

Removes a game from the lineup. Only the person who suggested it (or a moderator) can remove it.

---

### Joining and Leaving a Game

Each game card in the event channel has interactive buttons:

| Button | What it does |
|---|---|
| **Join** | Adds you as a player for this game. |
| **Leave** | Removes you from the game. |
| **Waitlist** | Joins the waitlist when the game is full. |
| **Leave Waitlist** | Removes you from the waitlist. |

If you join the waitlist and enough people accumulate to form a second copy of the game, the game owner is automatically notified that a second copy is needed. Even without a confirmed second copy, when the event locks the scheduler will still split a full waitlist into its own real group and give it a table session — you're not just stuck waiting to see if a seat opens up.

---

## Group Library

The `/library` command manages a shared catalog of games that members own. This library powers game suggestions — only games owned by an attending member can be suggested.

---

### Browsing the Library

```
/library list
```

Displays all games in the group library, with who owns each copy.

---

### Finding a Specific Game

```
/library view game:<game name>
```

Shows details for a specific game: owners, player count, play time, tags, expansions, and whether it's been requested for the next event. Supports partial name matching.

---

### Seeing Your Own Games

```
/library mine
```

Lists all games you've personally added to the library.

---

### Adding a Game You Own

```
/library add game:<game name>
```

Adds a game to your library so others can see and request it. If someone else already has that game in the library, the bot will confirm whether you want to add your own copy.

---

### Removing a Game

```
/library remove game:<game name>
```

Removes a game from your library. Use `/library mine` to see the exact names of your games.

---

### Editing Game Details

```
/library edit game:<game name>
```

Opens a form to update the details for a game you own:
- **Players** — e.g. `2-5` or `4`
- **Play time** — in minutes, e.g. `90`
- **Tags** — genre tags, e.g. `Co-op, Deck Building, Party`
- **Expansions** — comma-separated list of expansion names you own

Only owners of a game can edit its details.

---

### Requesting a Game for the Next Event

```
/library request game:<game name>
```

Requests that a game be brought to the next upcoming event. The request is posted publicly and the owner is notified. The game must be in the group library and the owner must be attending (Going or Maybe).

---

### Seeing Which of Your Games Are Requested

```
/library bring
```

Shows you which of your games people have requested for upcoming events — useful to know what to pack before you head out. Works from within an event channel (scoped to that event) or from anywhere (shows all upcoming events).

---

### Removing a Request

```
/library unrequest
```

Lets you remove games from the request list. A menu will appear with your current requests for you to pick from.

Moderators can see and remove all requests, not just their own.

---

### Importing Games from a CSV

```
/library import file:<CSV file>
```

Bulk-adds games to your library from a CSV file. Two formats are supported:

- **Simple list:** One game name per line.
- **BoardGameGeek export:** The standard BGG collection CSV export. The bot will automatically import only games you own (marked as `own = 1`), skip expansions, and pull in player count and play time from the file.

You can export your BGG collection at: `boardgamegeek.com → My Collection → Export`

---

### Clearing Your Library *(admin can clear others)*

```
/library clear
```

Removes all of your games from the group library. Admins can optionally target another member:

```
/library clear user:<@member>
```

---

## Game Preferences (Roles)

```
/myroles
```

Opens an interactive panel where you can select the types of games you enjoy. Selections are saved as Discord roles, which can be used to ping interested players when certain games come up.

**Available tags:**

Co-op · Competitive · Semi-Co-op · Team vs Team · Solo Friendly · Deck Building · Engine Building · Worker Placement · Area Control · Tile Placement · Drafting · Auction · Trick Taking · Roll & Write · Push Your Luck · Hand Management · Social Deduction · Hidden Roles · Bluffing · Party · Abstract · Economic · Dungeon Crawler · Legacy · Gateway / Family

Toggle any combination and hit **Save** to apply. You can re-run `/myroles` any time to update your preferences.

---

## Admin Commands

These commands require server administrator permissions.

---

### Event Configuration

```
/event config
```

Run with no options to see the current server defaults. Pass any options to update them:

| Option | Description |
|---|---|
| `location` | Default location for new events |
| `time` | Default start time (e.g. `7:00 PM`) |
| `end_time` | Default end time (e.g. `10:00 PM`) |
| `description` | Default event notes |
| `announcements` | Channel where RSVP embeds are posted |
| `open_channels` | `true` = event channels are visible to everyone; `false` = RSVP-gated (default) |

---

### Archiving Past Events

```
/event archive
```

Moves the channels for all past events into an Archive category and cleans up their announcement posts. Run this after an event has concluded to keep the server tidy.

---

### Managing Game Tags

Game tags are the genre labels used in `/myroles` and on game cards. Admins control which tags are available.

```
/gametags list
```
Shows all current game genre tags.

```
/gametags sync
```
Creates Discord roles for all built-in game tags at once. This is the fastest way to set up the tag system on a new server — it skips any tags that already exist.

```
/gametags add name:<tag name> color:<color>
```
Creates a single new tag. The `color` option accepts a hex code (e.g. `#5865F2`) or you can pick from an autocomplete list of named colors.

```
/gametags remove name:<tag name>
```
Deletes a tag and its associated Discord role.

---

### Welcome Message Configuration

```
/welcome config
```

Run with no options to see the current welcome settings. Pass any options to update them:

| Option | Description |
|---|---|
| `channel` | Channel where the welcome embed is posted when someone joins |
| `rules_channel` | Channel to link to in the welcome message |
| `facebook_url` | Facebook group URL to include in the welcome message |

```
/welcome test
```

Sends a preview of the welcome message as if you just joined the server. Useful for verifying the welcome embed looks right after a config change.

---

## Welcome System

When a new member joins the server, the bot automatically:

1. Posts a welcome embed in the configured welcome channel with links to the rules, announcements channel, `/myroles`, and the Facebook group.
2. Sends the new member a DM with a tip about setting a server nickname so the group knows who they are.

No commands are needed from the new member — this happens automatically.

---

*Questions or issues? Ping a server admin.*
