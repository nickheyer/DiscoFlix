# DiscoFlix v3 — Roadmap

Work happens in milestone blocks only (M0, M1, ...). **Feature Planning** at the
bottom is the unstaged backlog — items must be promoted into a milestone before
anyone works on them. Nothing goes below Feature Planning except more feature
planning.

## M0 — Stabilize (complete)

- [x] Remove echo-reply debug behavior from onMessage
- [x] Fix ws connection leak (`'close'` event, dead-socket pruning, single registration)
- [x] Escape all pug interpolations of Discord-controlled strings (XSS)
- [x] Cap + order chat message queries (newest 100, oldest-first display)
- [x] Fix broken `Configuration.update` / `updateSingleton` (`this.base` TypeError, undefined `include`)
- [x] Stop `_sanitizeData` wiping partial upserts (unread counts / sort order / active channel now survive guild re-syncs)
- [x] Fix errorHandler crash on errors without `.response`; debugHandler rethrows
- [x] Replace lodash mixins with explicit namespaces (`core.models/discord/render/sockets/system`)
- [x] Remove `global.logger`; all logging through `core.logger`
- [x] Sidebar renders + auto-selects uncategorized text channels
- [x] Fix `refreshUI` double-running `updateMessages` on empty channels

## M1 — The Engine (v2 parity: media requesting actually works) (complete)

- [x] `core.arr` namespace: Radarr API client (axios) — status, search, add, queue
- [x] Sonarr API client (same shape as Radarr)
- [x] Prefix command parsing (`!df movie|show <title>`) driven by config `prefix_keyword`
- [x] Discord slash command registration + handlers
- [x] Request pipeline: search → results → user selection → `Media` + `MediaRequest` rows
- [x] Enforce config/user limits (`max_results`, `max_seasons_for_non_admin`, `max_requests_in_day`, `is_active`)
- [x] Monitor arr queue; notify requester in-channel on grab/import
- [x] Trailer links in results (`is_trailers_enabled`)

## M2 — The Console (web UI becomes the bot's admin tool) (complete)

- [x] Request dashboard: pending/approved/denied/downloading/available + approve/deny actions
- [x] Bot posts approval verdicts back to the originating Discord channel
- [x] Wire chat input: send-as-bot into the active channel
- [x] Request-aware chat mirror: status chips/embeds on request-triggering messages
- [x] Render bot media embeds in the mirror (`messageEmbed`/`messageAttachment` stubs exist)
- [x] Live download progress in UI (arr queue polling → ws push)

Note: approval gating is role-based — `is_superuser`/`is_staff` requests auto-approve
and hit the arr immediately (v2 behavior); everyone else lands in the dashboard's
pending list. Verdicts post to the originating channel and mention all requesters.

## M3 — Hardening (complete)

- [x] Admin auth (password + session cookie) on all routes
- [x] Convert state-changing GETs to POST (`toggle-bot`, `toggle-power`, `change-active-*`)
- [x] Stop rendering secret values into settings form `value` attributes
- [x] Render pipeline consolidation: one `getComplete` per request, scoped ws emits instead of full-sidebar broadcasts
- [x] Debounce/batch guild-event full refresh (`onUpdateEvent` currently re-syncs everything per event)

Notes: auth is dormant until `Configuration.admin_password` is set (scrypt-hashed;
`DF_DISABLE_AUTH=1` is the lockout-recovery hatch; ws upgrades honor the same
session). Sensitive settings render empty with keep-on-blank semantics and an
explicit "clear saved value" checkbox. Config logging now logs field names, not
values (tokens were previously written to logfiles).

## M4 — UI/UX Refactor (complete)

- [x] Fix "ghost page" modal bug: `as-modal` search responses rendered `base.pug` *and* a second bare `_records.pug` into `#modals-here`; scrolling the modal revealed a full-screen duplicate of the config
- [x] Fix graceful-shutdown hang for real: `wss.close()` before terminating clients (htmx ws auto-reconnect was racing a fresh upgraded socket past http-terminator mid-shutdown), plus a 5s cap on `terminate()` so exit is guaranteed
- [x] Design tokens: `variables.css` rewritten around the classic (~2019) Discord palette (`--bg-primary/secondary/tertiary`, modifier overlays, classic blurple `#7289da`); legacy var names alias onto tokens
- [x] De-dupe CSS: colliding `@keyframes dash`/`fadeIn` (which broke the power loader), duplicated `.modal-footer`/`.record-header`/`.invite` rules; all keyframes now file-prefixed
- [x] Chat mirror made authentic: full-width left-aligned message rows (no more right-aligned bot bubbles or accent-tinted rows), 40px avatars, BOT-only tags (USER chip removed), muted timestamps, hover row highlight
- [x] Discord-markdown subset renderer (`markdownLite.js`, escape-first, http(s)-only links) wired into message text + embed descriptions/fields — `**bold**`, `` `code` ``, `[label](url)` now render instead of showing raw
- [x] Fix live-message username colors (accent hex was passed without `#` on the ws push path)
- [x] Remove "This is some message content!" placeholder leaking on embed-only messages
- [x] Chat input made in-flow (killed the `z-index: -1` floating-bar stacking hack); chat grid now `48px / 1fr / auto` instead of viewport-math rows
- [x] Sidebar: flex column (no more `calc(100% - 136px) !important`), 240px width, 48px guild banner, Discord channel-row hover/active states, right-edge padding fix, dead add-channel/"+" decorations removed
- [x] Channel gear no longer also switches the active channel (`hx-on:click` stopPropagation)
- [x] Userbox 52px + 32px avatar; toggles green like Discord; unread badges red
- [x] Modals: tokenized, small 440px confirm dialogs for power/invite, footer strip, search-icon alignment fix
- [x] Members pane stub hidden via `:empty` until the feature lands; mobile members overlay removed
- [x] Focus-visible outlines restored (global reset was nuking keyboard focus)
- [x] Login page on classic blurple

Note: `emitMessage`/`compileMessages` templates get `md()` injected by
`templateCompiler` — it escapes before substituting, so `!{md(...)}` is the
only sanctioned unescaped interpolation in the views.

## M5 — UI/UX Round 2 (authenticity corrections) (complete)

- [x] Members pane, populated for real: `core.render.getServerMembers` lists users
      tracked per server (join table fills as messages sync), rendered as a
      classic right-rail MEMBERS list (32px avatars, BOT tag, live status dot on
      the client bot); OOB-swaps on server change + refreshUI; still `:empty`-hides
      when there is nothing to show
- [x] Old-Discord mention treatment (yellow tint + left bar) restored — but only on
      rows that mean something (request-triggering messages), not per-author wallpaper
- [x] Classic red "NEW" unread divider — `updateMessages` captures the unread count
      before zeroing it and flags the first unread message for the shard template
- [x] "Welcome to #channel!" empty-state block replaces "No messages in here!"
- [x] Modal footers slimmed (8px), removed where redundant: settings modals have
      none (save toast rides in the header), dashboard keeps Refresh, invite keeps
      Invite, power dialogs keep Cancel; all redundant Close buttons dropped
- [x] Fix: Load More lost the active search (`hx-include` pointed at nonexistent
      `#search-bar`; the input is `#search-input`)

Known dev-loop quirk: rapid `--watch` restarts can interrupt a Discord login;
`startBot`'s failure path persists `discord_state: false`, which disables
autostart on every later boot until the bot is toggled back on in the UI.

## M6 — UI/UX Round 3 (in progress)

Polish (done 2026-07-11):

- [x] Page `<title>` rendered empty (`title= title`, nothing passed) — hardcoded "DiscoFlix"
- [x] Google Fonts href was double-escaped (`&amp;` in the pug attr → `&amp;amp;` in HTML), silently dropping `display=swap` — literal `&` now
- [x] Channel header rendered a leading space before the channel name (trailing space + piped text in `messageChannelHeader.pug`)
- [x] Cached image paths (`discord_bot_images/…`, `user_images/…`) rendered as relative URLs; normalized root-relative in `messageAvatar`/`membersLayout`/`userControlsAvatar`
- [x] No-active-channel header placeholder now keeps the 48px bar + elevation shadow instead of collapsing unstyled
- [x] `.chatMessageTag` (BOT chip) defined once in chat.css; members.css duplicate dropped
- [x] Chat "+" button was inert decoration — now opens the Media Requests dashboard (same modal wiring as the channel gear, cooltipz tooltip); the dashboard was previously only reachable through the settings sidebar
- [x] Disabled chat input copy: "Select a channel to start chatting" (was "No servers currently available..." even when servers existed)

Staged by Nick 2026-07-11, built same day (template/logic tests pass; needs one
live pass in the browser once the dev server is back up — it was stopped
mid-build, SIGINT at 19:33):

- [x] Avatar click → user config: chat avatars (history + live ws path both carry
      `userId` now) and members-pane rows open the user's settings form via
      `/settings/user/search?search=<discord_user_id>&as-modal=true`
- [x] Server Info (i) in the guild banner: hover-revealed icon next to the server
      name (inside `#guildNameBanner` so every oob swap keeps it on the active
      server); opens the guild's config modal
      (`/settings/discordServer/search?search=<server_id>&as-modal=true`).
      v1 shipped as a pinned pseudo-channel row — Nick: intrusive; moved to the
      banner where the (i) visibly belongs to the server
- [x] Chat decoration pass: classic date dividers between days (`compileMessages`
      flags day boundaries), right-edge hover action tray on request rows
      (approve/deny fire `hx-swap="none"` → the handler's `refreshUI()` pushes the
      new chip state back; plus an open-dashboard button), avatar pointer cursor
- [x] Message edits shown before → after: `previous_content`/`edited_at` columns
      (migration `20260712025112_message_edit_tracking`), `MessageUpdate` handler
      (+ `Partials.Message` — without it edits to uncached messages never fire),
      muted struck-through old line + `(edited)` marker, live in-place row swap
      over ws (`hx-swap-oob="outerHTML:#msg-<id>"`; rows now carry DOM ids).
      Embed-only edits (bot progress updates) update silently, no (edited) tag
- [x] App rail v1 (nzb360 direction): Radarr/Sonarr pseudo-guild bubbles below
      the guilds behind their own divider (green dot = configured+enabled), each
      opening a per-app dashboard modal — status pill (version/unreachable),
      `/health` warnings, live download queue with progress bars, "Open <app>"
      link-out, Refresh; unconfigured apps get a connect-it empty state.
      New: `GET /modal/apps/:app` (`api/apps.js`), `ArrClient.getHealth()`

## M7 — The Apps Platform (nzb360-style, expanded scope) (in progress)

Scope decisions (Nick, 2026-07-11): full multi-instance (two Radarrs = two rail
bubbles, own config each), all four apps ship (Radarr/Sonarr/SABnzbd/qBittorrent),
plus two hooks promoted from Feature Planning: live download ticker + first-run
onboarding. Full plan: ~/.claude/plans/hidden-stirring-zebra.md

Done (2026-07-11, steps 1–4 verified live; steps 5–6 verified by
template-compile + fixture renders only — needs one live browser pass):

- [x] `App` Prisma model (multi-instance rows) + `MediaRequest.appId` +
      `State.active_app_id`; hand-edited migration `20260712034610_apps_platform`
      carried radarr/sonarr config out of `Configuration` into App rows
      (is_default=1) — old config columns still present until the cleanup step
- [x] `core.apps` namespace (`src/core/methods/apps/`): manifest registry
      (replaces the 5 duplicated service tables), clients (arr pair relocated +
      normalized queue rows; NEW SABnzbd + qBittorrent w/ SID session cache),
      instance helpers (default-instance routing, testInstance, rail VM),
      monitor (watches keyed by appId, null-channel = console-initiated) +
      60s status/queue heartbeat feeding statusCache/queueCache + change-only
      ws broadcasts
- [x] Bot cutover: slash commands built from installed apps (only served content
      types register), prefix aliases from registry, requestFlow routes to
      default instance + stamps `appId` on MediaRequest, approve resolves
      posted-override → stored instance → default (+ per-row "Add to" select in
      the dashboard when >1 instance serves the type); `core.arr` deleted
- [x] Rail from DB: bubbles per App row, tooltips, heartbeat-cached status dots,
      green "+" add-app bubble, classic white pill indicator (rail-wide),
      appRail joined refreshUI/changeActiveServers emit sets
- [x] Takeover skeleton: POST /change-active-app/:id (10-fragment swap) +
      POST /apps/:id/section/:section (3-fragment; cross-instance = enters that
      app's takeover), sections-as-channel-rows, Overview section (cannibalized
      the M6 modal — modal + route deleted), reload-persistent via renderHome
      branch, guild-click back-out, refreshUI takeover guard, unread-count guard
      in logMessageToInterface
- [x] Settings section: manifest-driven form on the `+field` mixin (sensitive
      keep-on-blank + `__clear` free via safeUpdateOne; manifest whitelist
      stops cross-type field writes; blank-name guard) — saves auto-fire on
      change, toast rides the takeover header (settings-modal convention,
      appHeader now carries `#notification-container`); Test Connection pill;
      save refreshes statusCache immediately (toast says "Connected — vX" /
      "Saved — but unreachable"); make-default row for content managers with
      rivals; danger-zone remove → 440px confirm → DELETE /apps/:id
      (stopWatchesForInstance + cache prune; response = mirror restore).
      Endpoints: /apps/:id/save|test|default
- [x] Add-app picker modal (GET /modal/apps/picker — card per manifest type,
      kind chip, "N installed", types stay addable) + POST /apps/add/:type →
      instant takeover landing on Settings; display-name disambiguation
      ("Radarr 2"), first-in-family gets is_default; syncSlashCommands fired
      on every app CRUD

Remaining:

- [ ] One live browser pass over the takeover skeleton + settings flows
      (enter/section/reload/back-out; msg-during-takeover → badge not stomp;
      add "Radarr 2" → configure → dot green; blank-password save keeps
      secret, `__clear` clears — Test proves it; remove → mirror restore)
- [ ] Queue section live wiring (heartbeat already pushes queueBody + ticker;
      template shells exist) + download ticker aggregate verify end-to-end
- [ ] Library section: poster grid (CSS shipped) + getAll() pagination via
      revealed sentinel; History section: rows + arr /history pagination
      (getHistory() shipped on all 4 clients)
- [ ] Search & Add: operator-initiated requests via admin path
      (watchRequest channelId:null already supported), instance tabs when >1
- [ ] First-run onboarding checklist in empty mirror (trigger: no token or no
      servers)
- [x] Cleanup (2026-07-12): six arr columns dropped from Configuration
      (+ metadata + configuration.js defaults/toggles + updateTokens →
      discord-only), orphaned radarrButton/sonarrButton.pug deleted; then
      migrations flattened to a single `20260712004854_init` (no v3 releases
      exist, so no upgrade path to preserve) — dev DB rebuilt in place
      (data kept) and re-baselined via `migrate resolve --applied`
- [x] `npm run reset` caveat: moot — the flatten discarded the config
      carry-over migration entirely; init now builds the final schema

---

## Feature Planning (unstaged — promote before working)

- EventLog DB transport + log viewer modal (model + readonly modal support exist; logging.js never wired prisma)
- Per-browser-session active server/channel — multi-user UI (today `State` is a global singleton, deliberately single-user)
- Chat history pagination / infinite scroll (`getChannelMessages` already has a `before` cursor)
- Media library browser (Media model + poster cache exist)
- Download-complete DM notifications to requesters (v2 feature)
- Mobile layout pass (`mobile.css` exists, unmaintained)
- Members pane phase 2: per-user presence + role grouping (pane itself shipped in M5 from tracked users)
- Message grouping: collapse consecutive same-author messages within ~7min like Discord (each message currently renders a full author header)
- Bot presence/status line config (playing/watching text)
- NZB/torrent client integration beyond arr (v2 legacy scope — maybe drop)
- Arr connection "Test" button in the settings modal (`core.arr` status endpoint exists; wire a per-service check + result toast)
- `!df status` / `/status` command — show the caller's open requests + live download state from the arr queue
- DM request support (`logMessageToInterface` skips DMs entirely; request flow + notifications are guild-channel-only)
- Re-arm arr queue watches on boot (monitor state is in-memory; open MediaRequests are orphaned by a restart)
- Root folder / quality profile selection per request (pipeline defaults to first root folder + first profile)
- Discord role → permission mapping (staff/admin currently only settable by hand-editing User rows in settings modal)
- Perf: `logMessageToInterface` force-fetches the author from the Discord API on every message (`author.fetch(true)` busts cache); throttle or trust cache
- Season-level requesting for shows (request whole series only today; v2 allowed picking seasons)
- Logout button in the user-controls strip (`POST /logout` route already exists, no UI for it)
- Scoped ws emits, phase 2: per-bubble/per-channel oob swaps instead of container re-renders (`serverSortableContainer` still re-renders wholesale on every message)
- First-run onboarding: when no `discord_token`/arr is configured, the chat pane renders a "getting started" checklist (token → invite bot → connect arr → first request) instead of an empty mirror — the operator hook for new installs
- Arr status dots in the userbox: likely obsolete — the orphaned `radarrButton.pug`/`sonarrButton.pug` were deleted in the M7 cleanup, and the app rail now ships per-instance heartbeat status dots + a Test Connection pill in app settings
- "Coming Soon" virtual channel: read-only feed rendered from the Radarr/Sonarr calendar endpoints as bot-style messages (releases this week/month) — gives every server a reason to open the console daily
- Dashboard request rows deep-link to the originating message in the chat mirror (jump to channel, scroll, flash the mentioned row)
- Live download ticker: slim strip above the chat input showing active queue progress (the ws push pipeline already feeds the dashboard; surface it in the chat)
- Per-guild ops stats inside the Server Info modal: requests this week, top requesters, quota usage per user
- Weekly digest the bot posts to a configured channel ("added this week / now available") — retention hook for end users
- Availability answers before requesting: check Media/library (later Plex/Jellyfin) and reply "already on the server" with a link instead of opening a request
- Scope expansion, someday: Lidarr/Readarr clients (`arrClient` is already service-generic) for music/book requests
- Keyboard accessibility pass: channel rows, gears, and avatars are click-only divs — needs `role="button"`, `tabindex`, and key triggers
- Self-host vendor assets (htmx, ws.js, hyperscript, sweetalert2, bootstrap, cooltipz, fonts all come from CDNs) — one `npm` vendor step, works offline, no supply-chain surprises
