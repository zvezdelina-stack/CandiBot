[README.md](https://github.com/user-attachments/files/26911092/README.md)
# CandiBot

A Slack bot for SwingSearch. Recruiters DM it in plain English to search the Metaview candidate database.

Built by Josh Longnecker and Zvezdelina Naydenova.

- Josh: https://github.com/joshlongnecker/CandiBot
- Z: https://github.com/zvezdelina-stack/CandiBot

Stack: Node.js, Slack Bolt, Metaview API, Anthropic API, Railway

---

## Phase 0 Setup

### Step 1 — Create the Slack app

1. Go to https://api.slack.com/apps
2. Click **Create New App > From scratch**
3. Name it **CandiBot**, select your SwingSearch workspace, click **Create**

### Step 2 — Enable Socket Mode

1. In the left sidebar, click **Socket Mode**
2. Toggle **Enable Socket Mode** on
3. When prompted, name the token (e.g. `candibot-socket`) and click **Generate**
4. Copy the token that starts with `xapp-` — this is your `SLACK_APP_TOKEN`

### Step 3 — Add bot scopes

1. In the left sidebar, click **OAuth & Permissions**
2. Scroll to **Bot Token Scopes** and add:
   - `app_mentions:read`
   - `im:history`
   - `im:read`
   - `im:write`
3. Scroll up and click **Install to Workspace**, then **Allow**
4. Copy the **Bot User OAuth Token** that starts with `xoxb-` — this is your `SLACK_BOT_TOKEN`

### Step 4 — Copy the Signing Secret

1. In the left sidebar, click **Basic Information**
2. Scroll to **App Credentials**
3. Copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`

### Step 5 — Enable DM events

1. In the left sidebar, click **Event Subscriptions**
2. Toggle **Enable Events** on
3. Under **Subscribe to bot events**, click **Add Bot User Event**
4. Add `message.im`
5. Click **Save Changes**

### Step 6 — Enable messaging in App Home

1. In the left sidebar, click **App Home**
2. Scroll to **Show Tabs**
3. Check **Allow users to send Slash commands and messages from the messages tab**

### Step 7 — Set up the project locally

```bash
git clone https://github.com/zvezdelina-stack/CandiBot
cd CandiBot
npm install
cp .env.example .env
```

Open `.env` and fill in:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

### Step 8 — Run locally

```bash
npm run dev
```

### Step 9 — Deploy to Railway

1. Push repo to GitHub
2. Open Railway, click **New Project > Deploy from GitHub repo**
3. Select this repo
4. Go to **Variables** and add the three Slack env vars
5. Railway will run `npm start` automatically

---

## Checkpoint

DM the bot any message. It responds with "I heard you." in the thread.
That is the full Phase 0 checkpoint.

---

## Project structure (full build)

```
candibot/
  index.js       — Slack Bolt entry point, message handler
  agent.js       — Intent detection and orchestration
  metaview.js    — All Metaview API calls
  claude.js      — All Anthropic API calls
  scorer.js      — Scoring prompt and ranking
  formatter.js   — Slack Block Kit formatting
  session.js     — Per-user session state
  synonyms.js    — Seed synonym map
  .env           — Never commit
  .env.example
  package.json
  README.md
```
