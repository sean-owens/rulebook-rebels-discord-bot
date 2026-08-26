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
        - Timezone: American/New_York
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

- /admin challenge config (weekly "Guess the Board Game")
    - Needs:
        - Channel: a text channel for hints + guesses (e.g. #board-game-challenge)
        - Enabled: true
    - **Discord Developer Portal setting required first, or the bot won't even connect:** this feature reads plain-text guesses in the channel, which needs the privileged **Message Content Intent**. Go to https://discord.com/developers/applications → select the bot app → Bot page → enable "Message Content Intent" under Privileged Gateway Intents → Save Changes. Must be done separately for the dev bot app and the prod bot app (they're two separate Discord applications, not one bot reused in two servers) — dev before deploying this to dev, prod before promoting to production.