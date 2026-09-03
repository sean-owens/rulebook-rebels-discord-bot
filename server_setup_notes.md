enhancement notes:

- ways to filter library by tag/player count/etc 
- add template for buy/sell/trade 


setup notes for adding to server:
- create introductions channel (text)
- create announcements channel (forum)
- create marketplace channel (forum)

- /admin tags sync
    - Creates Discord roles for all default genre and difficulty tags at once
    - Members can then assign themselves tags via /myroles
    - Custom tags can be added afterward with /admin tags add

- /admin welcome config
    - Needs: 
        - Welcome channel -> #introductions
        - Rules channel -> server rules channel
        - FB Group -> Link
        - BGG Group -> N/A, we don't have one, skip (optional field)

- /admin event config
    - Needs:
        - Timezone: America/New_York
        - Location: Cypress Greens Clubhouse, 1000 Cypress Creek Blvd, Lake Alfred, FL, 33850
        - Time: 11am
        - End time: 8pm
        - Description: Monthly Board Game Meetup!
        - Announcement Channel: #announcements (forum)
        - Open Chanels: RSVP Only
        - Event Category: Events
        - Archive Category: Archive
        - Archive Retention Days: 0 (never)
        - Lock hours before event: 48hrs
        - table count = 1 (default)
        - light buffer min: 15min (default)
        - medium buffer min: 30min (default)
        - heavy budffer min: 45min (default)
        - post_bgstats_links: True
        - heavy game break minutes: 30min
        - max_game_repeat: 3
    - Also available (not currently set — all default to off/no-op):
        - max_tables: hard cap on concurrent tables regardless of table_count, e.g. a venue's physical table limit (0 = uncapped, default: 0)
        - break_minutes: extra gap before a person's next game can start, on top of the light/medium/heavy buffer above (default: 0)
        - flex_tables: reserve this many tables for Light-complexity games only (default: 0)

- /admin marketplace config
    - Needs:
        - Channel: #marketplace (forum)
        - Negotiation mode: private (default)

- /admin room config
    - Needs:
        - Category: Private Rooms

- /admin general config
    - Needs:
        - Channel: #general (or whatever your main/already-populated chat channel is)
    - Posts a pinned "🎮 Quick Actions" hub message there (RSVP to next event, browse library, my games, random game, request a game to bring) — a member-facing shortcut hub, distinct from the welcome channel

- /admin challenge config ("Guess the Board Game")
    - Needs:
        - Channel: a text channel for hints + guesses (e.g. #board-game-challenge) — auto-created with this name if omitted while enabling
        - Enabled: true
    - Also available (not currently set — all default to the classic weekly schedule):
        - frequency: daily / weekly (default) / bi-weekly — how often a new cycle starts
        - start_date: bi-weekly only, which week is "on" (e.g. "August 22") — defaults to the current week
        - clue1_day/clue1_hour, clue2_day/clue2_hour, clue3_day/clue3_hour, reveal_day/reveal_hour — custom hint/reveal schedule; default is Monday/Wednesday/Friday 8am + Saturday 6pm (daily mode ignores the `_day` options, only the hours matter)
        - cleanup_old_posts: delete the previous cycle's hint/reveal messages from the channel when a new one starts (default: false — keeps a scrollback of past answers)
    - **Discord Developer Portal setting required first, or the bot won't even connect:** this feature reads plain-text guesses in the channel, which needs the privileged **Message Content Intent**. Go to https://discord.com/developers/applications → select the bot app → Bot page → enable "Message Content Intent" under Privileged Gateway Intents → Save Changes. Must be done separately for the dev bot app and the prod bot app (they're two separate Discord applications, not one bot reused in two servers) — dev before deploying this to dev, prod before promoting to production.