# Beta Testing Feedback — Rulebook Rebels Bot

*Collected from Discord beta testing session, 6/24/2026 – 6/26/2026*

---

## Bugs

### Events

- **Normal users can create events** — Event creation is not restricted to admins. `/help` also incorrectly lists Event Creation under commands available to everyone; it should be in the admin-only section.
- **`/game list` does not show a recently scheduled game** — Possible propagation delay after scheduling.
- **`/game cancel` untestable** — Blocked by the `/game list` bug above.
- **`/game list` returns no results in the general channel** — The command requires an event context it cannot infer from outside an event channel.
- **No notification sent to game owner on `/game request`** — Owner is not alerted when someone requests one of their games.

### Library

- **`/library bring` does not work as described** — The command lists games others are supposed to bring rather than letting the current user declare they will bring a game. `/help` text for this command is also incorrect.
- **`/library request` always targets the next event regardless of channel** — Running the command from the June 29 event channel still creates a request for the June 27 event.
- **`/library request` requires exact name match** — "Wonderlands War" and "Wonderland's War" are treated as different games.
- **`/library list` returns partial results** — Truncated at Discord's character limit with no pagination.
- **`/library view` only returns exact matches** — Searching "Puerto Rico" will not surface "Puerto Rico 1897 SE" even though they are the same base game.
- **Weight/complexity not populated when manually adding a game** — Adding a game not already in the library should prompt for details (weight, complexity icons, etc.) but does not. The `/library edit` command can be used as a workaround.

---

## Feedback & Suggestions

### Events

- **`/game suggest` should auto-join the suggesting player** — The player making the suggestion should be automatically added as an interested participant.
- **Clarify `event config` purpose in documentation** — It appears to create a reusable event template (not edit existing events). This should be made explicit so admins know they can pre-configure it to save time.
- **`/event list` vs. `/game list` distinction is unclear** — The difference between the two list commands should be called out in `/help`. Typing `/list` alone defaulting to games is confusing.

### Library

- **`/library bring` needs a confirmation flow** — Users need a way to acknowledge a bring request and commit to bringing a specific game. Suggested commands:
  - `/library bring <Game>` — Confirms you will bring the requested game to an event.
  - `/library myrequests` — Shows all games you own that have been requested for an event.
- **`/library request` should let users pick the target event** — Add a dropdown listing all upcoming events so the user can choose which event they are requesting a game for.
- **Limit bring requests when multiple users own the same game** — If several members own a requested game, the request should go to only one of them rather than all owners to avoid duplicates.
- **Consider fuzzy/BGG-backed matching for game names** — Without validation, users can add arbitrary strings (e.g., typos like "Puerto Rico 197 SE") and games owned by multiple people may be listed under slightly different names, causing fragmentation. Options discussed: fuzzy match on add, or standardizing through BGG import/integration.
- **Clean up `/help` output for clarity** — The help text can be restructured to make command syntax less ambiguous, particularly the nested subcommand layout (`/event list`, `/event create`, etc.).
