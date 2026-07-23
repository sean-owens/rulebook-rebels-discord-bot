DEV: https://discord.com/oauth2/authorize?client_id=1524058711222652958&permissions=2251825852181552&integration_type=0&scope=applications.commands+bot

PROD: https://discord.com/oauth2/authorize?client_id=1518299080932200458&permissions=2251825852181552&integration_type=0&scope=applications.commands+bot

--- Bot Invite Link Reference ---

To regenerate this link:
  Discord Developer Portal → your app → OAuth2 → URL Generator
  Scope: bot + applications.commands

Required permissions:

  View Channels              — See channels to post in them
  Manage Channels            — Create event channels, set RSVP-only access, move channels to archive
  Manage Roles               — Create Admin/Host roles on server join, assign genre/difficulty roles via /myroles
  Manage Guild               — Required so the bot can create roles that carry ManageGuild permission (Admin role)
  Manage Events              — Create Discord Scheduled Events for game nights; required to create roles with ManageEvents (Host role)
  Send Messages              — Post game cards, RSVP embeds, announcements
  Embed Links                — Send rich embeds (game cards, library views, RSVP embeds, BGG data)
  Attach Files               — Send the "Powered by BGG" logo as a file attachment
  Read Message History       — Read existing messages to update/edit embeds
  Manage Messages            — Delete game cards on cancel
  Pin Messages               — Pin the Quick Actions/Game Lineup/Games to Bring/Snacks List messages. Split out from
                                Manage Messages as its own permission (bit 51) — Manage Messages alone no longer
                                covers pinning. Discovered 2026-07-23: every diagnostic (role bits, channel overwrite
                                bits) showed Manage Messages correctly granted, yet every pin attempt still 403'd,
                                because this bit specifically was missing from the original invite link.
  Manage Threads             — Archive marketplace forum threads when a listing is closed
  Mention @everyone and Roles — Mention roles in game request announcements

Note: updating the permissions integer here does NOT retroactively grant anything to a bot
already in a server — re-run the invite link (Discord allows re-authorizing without kicking
the bot first) to actually apply a permissions change to an existing installation.

