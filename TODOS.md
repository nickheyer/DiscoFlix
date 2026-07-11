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

## M1 — The Engine (v2 parity: media requesting actually works)

- [ ] `core.arr` namespace: Radarr API client (axios) — status, search, add, queue
- [ ] Sonarr API client (same shape as Radarr)
- [ ] Prefix command parsing (`!df movie|show <title>`) driven by config `prefix_keyword`
- [ ] Discord slash command registration + handlers
- [ ] Request pipeline: search → results → user selection → `Media` + `MediaRequest` rows
- [ ] Enforce config/user limits (`max_results`, `max_seasons_for_non_admin`, `max_requests_in_day`, `is_active`)
- [ ] Monitor arr queue; notify requester in-channel on grab/import
- [ ] Trailer links in results (`is_trailers_enabled`)

## M2 — The Console (web UI becomes the bot's admin tool)

- [ ] Request dashboard: pending/approved/denied/downloading/available + approve/deny actions
- [ ] Bot posts approval verdicts back to the originating Discord channel
- [ ] Wire chat input: send-as-bot into the active channel
- [ ] Request-aware chat mirror: status chips/embeds on request-triggering messages
- [ ] Render bot media embeds in the mirror (`messageEmbed`/`messageAttachment` stubs exist)
- [ ] Live download progress in UI (arr queue polling → ws push)

## M3 — Hardening

- [ ] Admin auth (password + session cookie) on all routes
- [ ] Convert state-changing GETs to POST (`toggle-bot`, `toggle-power`, `change-active-*`)
- [ ] Stop rendering secret values into settings form `value` attributes
- [ ] Render pipeline consolidation: one `getComplete` per request, scoped ws emits instead of full-sidebar broadcasts
- [ ] Debounce/batch guild-event full refresh (`onUpdateEvent` currently re-syncs everything per event)

---

## Feature Planning (unstaged — promote before working)

- EventLog DB transport + log viewer modal (model + readonly modal support exist; logging.js never wired prisma)
- Per-browser-session active server/channel — multi-user UI (today `State` is a global singleton, deliberately single-user)
- Chat history pagination / infinite scroll (`getChannelMessages` already has a `before` cursor)
- Media library browser (Media model + poster cache exist)
- Download-complete DM notifications to requesters (v2 feature)
- Members sidebar pane (`membersLayout.pug` stub)
- Mobile layout pass (`mobile.css` exists, unmaintained)
- Bot presence/status line config (playing/watching text)
- NZB/torrent client integration beyond arr (v2 legacy scope — maybe drop)
