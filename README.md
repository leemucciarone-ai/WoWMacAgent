# WoW Tweet Bot

Three things, one always-on service:

1. **Daily evergreen tweet** — rotates five angles (hot take, M+ pain, audience
   question, guild flex, coaching nugget), pushed to Discord with
   **Approve / Edit / Regenerate / Reject** buttons. On approval it schedules to
   the best open slot in your 12 AM–8 PM window. Each draft includes a YouTube
   community post to copy-paste. No news, nothing that goes stale.
2. **Patch watcher (automatic, any day)** — polls Wowhead's retail + in-dev feeds
   every 20 minutes, filters to patch/tuning/hotfix titles only, and the moment a
   real one drops it **DMs you** and auto-drafts a take grounded in the actual
   notes. Runs independently of the daily tweet, so a mid-day drop still lands "in
   the chamber" even if today's evergreen is already scheduled.
3. **/patch (manual)** — a **user-installable** slash command, so it works right in
   your DMs. Run `/patch source: <Wowhead/Blizzard URL or pasted notes>` any time.

All three flow through the same approval + collision-free scheduling, so two tweets
in one day never fight over the same slot.

## What you need to gather

**Discord** (delivery is via DM, so you need two quick things)
1. Create an app + bot at https://discord.com/developers → copy the **bot token**.
2. In the app's **Installation** settings, enable **both** install contexts —
   **Guild Install** and **User Install** — and save.
3. **Add the bot to a server you're in** (a private server with just you is ideal).
   A bot can only DM you if you share a server with it, and that's what lets the
   automated daily/watcher drafts reach your DMs.
4. **Install the app to your own account** using the app's install link, so the
   `/patch` command works inside your DMs.
5. Enable Developer Mode, then copy **your user ID** → `DISCORD_APPROVER_ID`.
   (No channel or server IDs are needed anymore.)

**X / Twitter**
1. At https://developer.x.com create a Project + App.
2. Set **User authentication** to **Read and Write**.
3. Generate the four OAuth 1.0a values: **API Key, API Key Secret, Access Token, Access Token Secret**.
4. Load a few dollars of prepaid credits (plain-text posts are $0.015 each).

**Anthropic** — an API key from https://console.anthropic.com.

## Setup

```bash
cp .env.example .env      # fill in every value
npm install
npm start
```

## Deploy on Railway

1. Push this folder to GitHub and create a Railway project from it.
2. In Railway → **Variables**, add every key from `.env.example`.
   **Set `TZ=America/New_York`.**
3. Start command is `npm start`.
4. (Recommended) Add a small **Railway volume** mounted at `./data` so both the
   watcher's seen-list (`seen.json`) and the tweet queue (`state.json`) survive
   redeploys. Without it, an in-flight approved tweet is still restored across a
   plain process restart, but a full redeploy that wipes the filesystem would lose
   it, and the watcher would re-baseline (harmless).

## How the watcher decides what's a "patch drop"

A feed item alerts only if its title contains one of `PATCH_KEYWORDS`. Everything
else in the feed is ignored, so general news never reaches you. On first boot it
records the current feed as a silent baseline and only alerts on genuinely new
posts after that. Add Blizzard or other feeds to `PATCH_FEEDS` (comma-separated)
if you want more sources; widen/narrow `PATCH_KEYWORDS` to taste.

## Cost

One plain-text tweet/day ≈ **$0.45/month** in X credits, plus fractions of a cent
per draft in Anthropic tokens. The watcher's polling is free; patch takes only cost
tokens when something actually drops.

## Tuning engagement

- **`POST_SLOTS`** are starting heuristics — replace with your real best times once
  you have analytics.
- **Content angles** live in `ANGLES` inside `index.js`; add, remove, or reweight
  to dial in your voice.

## Persistence

Pending drafts and approved-but-unposted tweets are written to `data/state.json`
and restored on boot: buttons keep working after a restart, and a scheduled tweet
either re-arms for its slot or, if its time passed while the bot was down, posts
immediately on startup. The watcher's seen-list persists to `data/seen.json`. Put
`data/` on a Railway volume (see above) so all of this also survives redeploys.

If a scheduled post fails to send at fire time, it's dropped (not retried) and you
get a failure notice in Discord with the text, so you can repost manually.

## Note on parsing

`fetchNotes` strips HTML generically. If a particular source page comes through
messy, paste the notes text into `/patch` instead of a URL.
