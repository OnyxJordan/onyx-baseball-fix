# Support Bridge: Discord → Zendesk

A Discord bot that turns messages from your community into Zendesk tickets so
the support team works out of one queue.

## What it does

- **Auto-tickets from a support channel.** Anyone who posts in your designated
  `#support` channel gets a Zendesk ticket created automatically. The bot
  replies with the ticket number (e.g. *Ticket #123 created*) and opens a
  Discord thread on the message.
- **Two-way-ish threads.** Follow-up messages the user (or anyone) posts inside
  that thread are appended to the same Zendesk ticket as comments, so agents
  see the whole conversation. Synced messages get a 📨 reaction.
- **`/ticket subject description`** — open a ticket explicitly from any channel
  (response is private to the user).
- **`/status number`** — check a ticket's current Zendesk status.

Each Discord user maps to a stable Zendesk requester via a synthetic email
(`discord.<user_id>@<REQUESTER_EMAIL_DOMAIN>`), since Discord doesn't expose
real email addresses. All tickets are tagged `discord` in Zendesk.

## Setup

### 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application**.
2. Under **Bot**, copy the **Token** (this is `DISCORD_BOT_TOKEN`).
3. Still under **Bot**, enable the **Message Content Intent** (required to read
   messages in the support channel).
4. Under **OAuth2 → URL Generator**, select scopes `bot` + `applications.commands`
   and bot permissions: *View Channels, Send Messages, Send Messages in Threads,
   Create Public Threads, Add Reactions, Read Message History*. Open the
   generated URL and invite the bot to your server.

### 2. Create the Zendesk API token

1. Zendesk **Admin Center → Apps and integrations → Zendesk API**.
2. Enable **Token access** and add an API token (this is `ZENDESK_API_TOKEN`).
3. `ZENDESK_EMAIL` is the agent/admin account the token belongs to, and
   `ZENDESK_SUBDOMAIN` is the `yourcompany` part of `yourcompany.zendesk.com`.

### 3. Configure and run

```bash
cd support_bridge
cp .env.example .env   # fill in the values
pip install -r requirements.txt
cd ..
python -m support_bridge.bot
```

Get `SUPPORT_CHANNEL_ID` by enabling **Developer Mode** in Discord
(User Settings → Advanced), then right-click your support channel →
**Copy Channel ID**.

For production, run it under a process manager so it restarts on failure,
e.g. a `systemd` service or `pm2 start "python -m support_bridge.bot"`.

## Notes & limits

- The thread → ticket mapping is stored in `support_bridge/tickets.json`
  (git-ignored). Keep this file if you move hosts, or old threads will stop
  syncing.
- Sync is one-way: Discord → Zendesk. Agent replies in Zendesk don't post back
  to Discord (agents can reply in the Discord thread manually, or this can be
  added later with a Zendesk webhook + a small HTTP endpoint).
- Attachments aren't uploaded to Zendesk; only message text is synced.
