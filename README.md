<div align="center">

<img src="docs/media/hero.svg" alt="DiscoFlix - the Discord concierge for your media server" width="100%">

<br><br>

<img src="docs/media/badge-selfhosted.svg" alt="self-hosted: single binary">&nbsp;<img src="docs/media/badge-discord.svg" alt="discord.js v14">&nbsp;<img src="docs/media/badge-stack.svg" alt="koa + htmx, no build step">&nbsp;<img src="docs/media/badge-db.svg" alt="prisma + sqlite">

<br><br>

**Ask for a movie in Discord. DiscoFlix searches your services, handles the approval,<br>tracks the download, and replies when it's ready to watch.**

</div>

<br>

## One request, start to finish

<div align="center">

<img src="docs/media/discord-flow.svg" alt="Animated: a user requests a movie, staff approves it on a Discord button, the download progresses to 100%, and the movie becomes available" width="760">

<sub>Request lifecycle.</sub>

</div>

<br>

## The console is a Discord mirror

The og discord, the good one. 

<img src="docs/media/console-chat-cards.png" alt="DiscoFlix web console mirroring a Discord channel: request cards show pending approval buttons, a live download at 62%, and an approved request">

<br>

## Mission control for the whole stack

<table>
<tr>
<td width="50%">
<img src="docs/media/console-overview.png" alt="Overview: bot identity, health notices, at-a-glance stats, and every connected app with live version pills">
<br><sub><b>Overview</b> - all the apps.</sub>
</td>
<td width="50%">
<img src="docs/media/console-requests.png" alt="Requests: pipeline cards with stage steppers from Requested through Decision, Radarr, Download, Imported, and media server">
<br><sub><b>Requests</b> - approval pipelines and the ability to track the lifecycle of a request.</sub>
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/media/console-library.png" alt="Unified library: poster grid across Radarr and Sonarr with availability dots and movie/show filters">
<br><sub><b>Library</b> - combined library, derived (and deduped) from all media servers.</sub>
</td>
<td width="50%">
<img src="docs/media/radarr-queue.png" alt="Download queue: progress bars, quality and indexer chips, time remaining, and a grabbed/imported activity feed">
<br><sub><b>Queue</b> - live progress for all your download clients in one place.</sub>
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/media/plex-sessions.png" alt="Now playing: active Plex sessions with direct play and transcode chips, watch progress, and recently added">
<br><sub><b>Now playing</b> - who is watching what.</sub>
</td>
<td width="50%">
<img src="docs/media/console-users.png" alt="Users: cards with tier chips, wants-access flags, per-user limits, and operator notes">
<br><sub><b>Users</b> - tiers, limits, and a WANTS ACCESS flags.</sub>
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/media/console-profile.png" alt="User profile modal: permission tier ladder, limits, notes, and the user's request history">
<br><sub><b>Profiles</b> - grant a tier, cap requests, keep receipts.</sub>
</td>
<td width="50%">
<img src="docs/media/console-logs.png" alt="Logs: searchable, level-filtered event log rows with metadata">
<br><sub><b>Logs</b> - ...I dont know how to excite people about logs.</sub>
</td>
</tr>
</table>

<br>

## Optional AI-powered everything

Plug in Anthropic, OpenAI, Gemini, or a local Ollama. The assistant has access to all your users, what media you have downloaded/monitored/queued, and of course - the discord bot (**you can turn these off incrementally if thats too intrusive for you, but thats why we include ollama**). 

<img src="docs/media/ai-chat-thread.png" alt="Console AI chat: the assistant plans a triple feature from the library, citing the tools it used - media_library, open_requests, download_queue">

<table>
<tr>
<td width="50%">
<img src="docs/media/console-bot-ai.png" alt="AI routing board: a who-answers ribbon and ranked provider rows per door, each with audience, daily caps, and memory settings">
<br><sub><b>Routing</b> - commands, mentions, and DMs each pick their own provider, audience, and memory.</sub>
</td>
<td width="50%">
<img src="docs/media/ai-directives.png" alt="Directives: every system prompt block is a card with a lifecycle stepper, customizable text, and a live template-variables rail">
<br><sub><b>Directives</b> - system prompt, go nuts.</sub>
</td>
</tr>
</table>

<br>

## How it fits together

```mermaid
flowchart LR
    discord(["Discord"]) <--> core{{"DiscoFlix"}}
    console(["Web console"]) <--> core
    core --> arr["Radarr / Sonarr / Lidarr"]
    core --> dl["SABnzbd / qBittorrent / NZBGet / +5"]
    core --> media["Plex / Emby / Jellyfin"]
    core --> ai["Anthropic / OpenAI / Gemini / Ollama"]
```

<br>

## Run it

<details>
<summary><b>Docker</b> (recommended)</summary>

```bash
docker run -d --name discoflix \
  -p 5001:5001 \
  -v discoflix_data:/data \
  nickheyer/discoflix:latest
```

Or grab [`docker-compose.yml`](docker-compose.yml) and `docker compose up -d`.

</details>

<details>
<summary><b>From source</b></summary>

```bash
git clone https://github.com/nickheyer/DiscoFlix.git
cd DiscoFlix
npm install
npm start        # or: make dev (auto-restarts on change)
```

Node 20+. The schema migrates itself on first boot.

</details>

<details>
<summary><b>Single binary</b></summary>

```bash
npm install
npm run build:binary   # -> dist/discoflix
```

Data lands next to the binary in `discoflix-data/` (override with `DF_DATA_DIR`).

</details>

Then open `http://localhost:5001`, paste your Discord bot token, and flip the power switch. Everything is configured in the console - or seed first-boot settings from the environment with [.env.example](.env.example).

### Inspect the database

DiscoFlix ships its own admin panel - no external tools. Enable **Database Admin** in the DiscoFlix app's Settings (or set `DF_DB_ADMIN=1` before first boot) and it serves a standalone editor at `http://localhost:5001/admin` (a Database shortcut also appears in the DiscoFlix app and opens it in a new tab). It reads the schema straight from the Prisma models, so every table, column, relation, and index shows up automatically: search, sort, filter by clicking any foreign key, edit or create rows in the side editor, bulk-edit or bulk-delete the checked rows (or everything matching the current filter), and drop to raw SQL when you want it.

It edits the live database with no guardrails - that's the point - so if the console is reachable by anyone but you, set an admin password. DiscoFlix will nag you about exactly that (dismissable) if you enable it on a password-less console.

<br>

---

<div align="center">

<sub>Every screenshot above is the real UI (kinda?), captured live against a fictional showcase dataset - the movies, the users, and yes, the posters were all invented for this README (imagine if I used real movie posters, id never do that).</sub>

<br><br>

<sub>Built by Nicholas Heyer &nbsp;&middot;&nbsp; ISC License</sub>

</div>
