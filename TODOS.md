# DiscoFlix v3 - Roadmap

Work happens in milestone blocks only (M0, M1, ...). **Feature Planning** at the
bottom is the unstaged backlog - items must be promoted into a milestone before
anyone works on them. Nothing goes below Feature Planning except more feature
planning.

## CODE RULES
1. Never use emojis, always use high quality svg's of some sort
2. Whenever you write a comment in code, it can only be 1 line tall and 1 sentence long maximum. Never use more words than you have to. AND ALWAYS UPPER CASE EACH LETTER. 
3. Never leave placeholder, stale, or lazily implemented code in the code base at any point.
4. No em or es dashes. No ellpsis characters. No ; or : outside of syntactical usage.
5. No need to end comment with punctuation or include the symbol name you are annotating.

## M0 - Stabilize (complete)

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

## M1 - The Engine (v2 parity: media requesting actually works) (complete)

- [x] `core.arr` namespace: Radarr API client (axios) - status, search, add, queue
- [x] Sonarr API client (same shape as Radarr)
- [x] Prefix command parsing (`!df movie|show <title>`) driven by config `prefix_keyword`
- [x] Discord slash command registration + handlers
- [x] Request pipeline: search → results → user selection → `Media` + `MediaRequest` rows
- [x] Enforce config/user limits (`max_results`, `max_seasons_for_non_admin`, `max_requests_in_day`, `is_active`)
- [x] Monitor arr queue; notify requester in-channel on grab/import
- [x] Trailer links in results (`is_trailers_enabled`)

## M2 - The Console (web UI becomes the bot's admin tool) (complete)

- [x] Request dashboard: pending/approved/denied/downloading/available + approve/deny actions
- [x] Bot posts approval verdicts back to the originating Discord channel
- [x] Wire chat input: send-as-bot into the active channel
- [x] Request-aware chat mirror: status chips/embeds on request-triggering messages
- [x] Render bot media embeds in the mirror (`messageEmbed`/`messageAttachment` stubs exist)
- [x] Live download progress in UI (arr queue polling → ws push)

Note: approval gating is role-based - `is_superuser`/`is_staff` requests auto-approve
and hit the arr immediately (v2 behavior); everyone else lands in the dashboard's
pending list. Verdicts post to the originating channel and mention all requesters.

## M3 - Hardening (complete)

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

## M4 - UI/UX Refactor (complete)

- [x] Fix "ghost page" modal bug: `as-modal` search responses rendered `base.pug` *and* a second bare `_records.pug` into `#modals-here`; scrolling the modal revealed a full-screen duplicate of the config
- [x] Fix graceful-shutdown hang for real: `wss.close()` before terminating clients (htmx ws auto-reconnect was racing a fresh upgraded socket past http-terminator mid-shutdown), plus a 5s cap on `terminate()` so exit is guaranteed
- [x] Design tokens: `variables.css` rewritten around the classic (~2019) Discord palette (`--bg-primary/secondary/tertiary`, modifier overlays, classic blurple `#7289da`); legacy var names alias onto tokens
- [x] De-dupe CSS: colliding `@keyframes dash`/`fadeIn` (which broke the power loader), duplicated `.modal-footer`/`.record-header`/`.invite` rules; all keyframes now file-prefixed
- [x] Chat mirror made authentic: full-width left-aligned message rows (no more right-aligned bot bubbles or accent-tinted rows), 40px avatars, BOT-only tags (USER chip removed), muted timestamps, hover row highlight
- [x] Discord-markdown subset renderer (`markdownLite.js`, escape-first, http(s)-only links) wired into message text + embed descriptions/fields - `**bold**`, `` `code` ``, `[label](url)` now render instead of showing raw
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
`templateCompiler` - it escapes before substituting, so `!{md(...)}` is the
only sanctioned unescaped interpolation in the views.

## M5 - UI/UX Round 2 (authenticity corrections) (complete)

- [x] Members pane, populated for real: `core.render.getServerMembers` lists users
      tracked per server (join table fills as messages sync), rendered as a
      classic right-rail MEMBERS list (32px avatars, BOT tag, live status dot on
      the client bot); OOB-swaps on server change + refreshUI; still `:empty`-hides
      when there is nothing to show
- [x] Old-Discord mention treatment (yellow tint + left bar) restored - but only on
      rows that mean something (request-triggering messages), not per-author wallpaper
- [x] Classic red "NEW" unread divider - `updateMessages` captures the unread count
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

## M6 - UI/UX Round 3 (in progress)

Polish (done 2026-07-11):

- [x] Page `<title>` rendered empty (`title= title`, nothing passed) - hardcoded "DiscoFlix"
- [x] Google Fonts href was double-escaped (`&amp;` in the pug attr → `&amp;amp;` in HTML), silently dropping `display=swap` - literal `&` now
- [x] Channel header rendered a leading space before the channel name (trailing space + piped text in `messageChannelHeader.pug`)
- [x] Cached image paths (`discord_bot_images/…`, `user_images/…`) rendered as relative URLs; normalized root-relative in `messageAvatar`/`membersLayout`/`userControlsAvatar`
- [x] No-active-channel header placeholder now keeps the 48px bar + elevation shadow instead of collapsing unstyled
- [x] `.chatMessageTag` (BOT chip) defined once in chat.css; members.css duplicate dropped
- [x] Chat "+" button was inert decoration - now opens the Media Requests dashboard (same modal wiring as the channel gear, cooltipz tooltip); the dashboard was previously only reachable through the settings sidebar
- [x] Disabled chat input copy: "Select a channel to start chatting" (was "No servers currently available..." even when servers existed)

Staged by Nick 2026-07-11, built same day (template/logic tests pass; needs one
live pass in the browser once the dev server is back up - it was stopped
mid-build, SIGINT at 19:33):

- [x] Avatar click → user config: chat avatars (history + live ws path both carry
      `userId` now) and members-pane rows open the user's settings form via
      `/settings/user/search?search=<discord_user_id>&as-modal=true`
- [x] Server Info (i) in the guild banner: hover-revealed icon next to the server
      name (inside `#guildNameBanner` so every oob swap keeps it on the active
      server); opens the guild's config modal
      (`/settings/discordServer/search?search=<server_id>&as-modal=true`).
      v1 shipped as a pinned pseudo-channel row - Nick: intrusive; moved to the
      banner where the (i) visibly belongs to the server
- [x] Chat decoration pass: classic date dividers between days (`compileMessages`
      flags day boundaries), right-edge hover action tray on request rows
      (approve/deny fire `hx-swap="none"` → the handler's `refreshUI()` pushes the
      new chip state back; plus an open-dashboard button), avatar pointer cursor
- [x] Message edits shown before → after: `previous_content`/`edited_at` columns
      (migration `20260712025112_message_edit_tracking`), `MessageUpdate` handler
      (+ `Partials.Message` - without it edits to uncached messages never fire),
      muted struck-through old line + `(edited)` marker, live in-place row swap
      over ws (`hx-swap-oob="outerHTML:#msg-<id>"`; rows now carry DOM ids).
      Embed-only edits (bot progress updates) update silently, no (edited) tag
- [x] App rail v1 (nzb360 direction): Radarr/Sonarr pseudo-guild bubbles below
      the guilds behind their own divider (green dot = configured+enabled), each
      opening a per-app dashboard modal - status pill (version/unreachable),
      `/health` warnings, live download queue with progress bars, "Open <app>"
      link-out, Refresh; unconfigured apps get a connect-it empty state.
      New: `GET /modal/apps/:app` (`api/apps.js`), `ArrClient.getHealth()`

## M7 - The Apps Platform (nzb360-style, expanded scope) (in progress)

Scope decisions (Nick, 2026-07-11): full multi-instance (two Radarrs = two rail
bubbles, own config each), all four apps ship (Radarr/Sonarr/SABnzbd/qBittorrent),
plus two hooks promoted from Feature Planning: live download ticker + first-run
onboarding. Full plan: ~/.claude/plans/hidden-stirring-zebra.md

Done (2026-07-11, steps 1–4 verified live; steps 5–6 verified by
template-compile + fixture renders only - needs one live browser pass):

- [x] `App` Prisma model (multi-instance rows) + `MediaRequest.appId` +
      `State.active_app_id`; hand-edited migration `20260712034610_apps_platform`
      carried radarr/sonarr config out of `Configuration` into App rows
      (is_default=1) - old config columns still present until the cleanup step
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
      the M6 modal - modal + route deleted), reload-persistent via renderHome
      branch, guild-click back-out, refreshUI takeover guard, unread-count guard
      in logMessageToInterface
- [x] Settings section: manifest-driven form on the `+field` mixin (sensitive
      keep-on-blank + `__clear` free via safeUpdateOne; manifest whitelist
      stops cross-type field writes; blank-name guard) - saves auto-fire on
      change, toast rides the takeover header (settings-modal convention,
      appHeader now carries `#notification-container`); Test Connection pill;
      save refreshes statusCache immediately (toast says "Connected - vX" /
      "Saved - but unreachable"); make-default row for content managers with
      rivals; danger-zone remove → 440px confirm → DELETE /apps/:id
      (stopWatchesForInstance + cache prune; response = mirror restore).
      Endpoints: /apps/:id/save|test|default
- [x] Add-app picker modal (GET /modal/apps/picker - card per manifest type,
      kind chip, "N installed", types stay addable) + POST /apps/add/:type →
      instant takeover landing on Settings; display-name disambiguation
      ("Radarr 2"), first-in-family gets is_default; syncSlashCommands fired
      on every app CRUD

Built 2026-07-12 (commit 067ba5f - template/logic verification only, all of it
rides on the same live pass below):

- [x] Queue section live wiring - heartbeat feeds queueCache, section render
      and ws push share queueBody.pug, whole-list oob swap w/ stable row ids
      for smooth progress bars; download ticker aggregate emitted on change
- [x] Library section - poster grid sliced from a TTL-cached full listing
      (arr returns everything in one call), revealed-sentinel pagination,
      cache invalidated on console adds
- [x] History section replaced by an activity feed in the right rail
      (browse.js) - rides along every section where the members pane was,
      cached page 1 refreshed by the heartbeat change-only, revealed-sentinel
      pagination via getHistory() on all 4 clients
- [x] Search & Add - debounced per-instance search, row states
      (addable/in-library/available/added/error), operator add =
      pre-approved MediaRequest w/ null-channel watch + library cache bust,
      double-add guard reflects reality, instance tabs when rivals serve the
      same content type
- [x] First-run onboarding checklist in empty mirror (gettingStarted.pug via
      core.render.getOnboarding, wired through home/sidebar/mirror renders)

Built 2026-07-12, second pass (rides the same live pass below):

- [x] Fix: guild syncs during a takeover resurrected the chat input/header/
      banner over the app surface (updateServerSortOrder emitted chat chrome
      unguarded; the logMessageToInterface unknown-channel path triggered it
      on incoming messages) - now rail-only while an app is active
- [x] Full-width surfaces: dropped the 960px appSectionBody cap; search bar
      spans the view; settings fields flow into columns on wide viewports
- [x] Library item detail view (GET /apps/:id/library/item/:itemId swaps
      #appSectionBody): fanart hero + poster, availability/monitored chips,
      ratings row, genre/runtime/cert line, facts rail, Radarr file card
      (quality/resolution/HDR/codecs/group), Sonarr season table with
      progress bars; actions wired for real - monitor toggle and automatic
      search (POST .../item/:itemId/:verb re-renders detail + header toast);
      poster cards open this in-console view
- [x] Link-out policy (per Nick): the "Open <app>" header icon and overview
      URL anchor stay - link-outs are a convenience, never a substitute for
      in-console features; library cards now open the in-console detail
      view instead of deep-linking per item; metadata references
      (IMDb/TMDB/TVDB/trailer) render as external chips on the detail view
- [x] Queue rows at native parity: media title via /queue expansion flags
      (includeMovie/includeSeries+Episode), release-name subline, quality/
      protocol/category/client/indexer chips, "42% of 7.5 GB" progress text,
      qBit per-torrent speed + seeds, SAB global rate pinned on the active
      slot, warning triangle carrying arr statusMessages as a tooltip
- [x] Env settings seed as a real feature (core.apps.seedFromEnv, awaited at
      the top of autoStartBot): DISCORD_TOKEN + manifest-derived
      <TYPE>_<FIELD> vars (RADARR_URL, RADARR_API_KEY, QBITTORRENT_USERNAME,
      ...) fill empty settings only - UI edits always win, one instance per
      type (multi-instance stays UI-only), missing instances are created and
      land on Overview already configured; DEV_TOKEN fallback and orphaned
      updateTokens deleted; .env.example documents the contract

Remaining:

- [ ] THE live browser pass over the whole takeover surface
      (enter/section/reload/back-out; msg-during-takeover → badge not stomp;
      add "Radarr 2" → configure → dot green; blank-password save keeps
      secret, `__clear` clears - Test proves it; remove → mirror restore;
      queue bars move during a real download + ticker matches; library
      scroll pagination; feed pagination; search → add → row flips to
      added → library grid shows it; onboarding renders on empty install;
      poster → detail view (hero/facts/file card/seasons), monitor toggle
      flips the chip, item search toasts, Back restores the grid; enriched
      queue rows show chips/sizes/speeds + warning tooltips; fresh-DB boot
      seeds token + all four apps from .env)
- [x] Cleanup (2026-07-12): six arr columns dropped from Configuration
      (+ metadata + configuration.js defaults/toggles + updateTokens →
      discord-only), orphaned radarrButton/sonarrButton.pug deleted; then
      migrations flattened to a single `20260712004854_init` (no v3 releases
      exist, so no upgrade path to preserve) - dev DB rebuilt in place
      (data kept) and re-baselined via `migrate resolve --applied`
- [x] `npm run reset` caveat: moot - the flatten discarded the config
      carry-over migration entirely; init now builds the final schema

## M8 - The DiscoFlix App + Read-Only Popups (in progress)

Scope (Nick, 2026-07-12): the Discord home badge becomes the entry point for
DiscoFlix's own takeover surface (a health panel like the app overviews);
editable settings move out of dialog popups into takeover surfaces; every
info popup goes strictly read-only; the power-bar settings cog is removed
and a cog rides the home badge on hover instead.

Built 2026-07-12 (fixture renders + route/registry/save-semantics smoke only -
rides the same live pass below):

- [x] DiscoFlix as a hidden app type: `discoflix` manifest (no Client, no
      configFields, sections overview/users/settings) + one self App row
      created on first badge click (`getSelfInstance`) - the whole takeover
      stack (active_app_id persistence, section nav, header toast, feed rail,
      reload survival, guild-click back-out) reused with zero schema changes.
      Hidden manifests are excluded from the picker, the rail bubbles, env
      seeding, heartbeat polling, and remove/test/default endpoints
- [x] Home badge = DiscoFlix bubble: click enters the takeover
      (POST /discoflix), hover reveals a settings cog (the power-bar cog's
      spin animation moved here) that jumps straight to Settings
      (POST /discoflix/section/settings), classic white rail pill when
      active, red problem dot (bot-on-but-offline / unreachable apps) fed by
      the rail VM; self-oob fragment added to every rail emit set incl. the
      heartbeat and updatePowerState
- [x] Overview section - the health panel: bot identity block (avatar,
      name#discriminator, online/offline pill, powered on/off subline),
      Needs Attention notices (no token, powered-off, on-but-disconnected,
      no admin password, zero servers, unreachable/disabled apps), stat
      tiles (servers/users/requests/pending/downloading), connected-app rows
      (status pill, click enters that app's takeover), Media Requests +
      Invite Bot + Refresh actions; right-rail feed = the bot's own ledger
      (MediaRequests as pending/approved/denied/available rows, paginated)
- [x] Users section - the mutable side of user management, abstracted out of
      the popup: searchable paginated user cards (identity header read-only,
      accent color, ADMIN/STAFF/BOT/INACTIVE chips, (i) opens the read-only
      popup), auto-saving form for exactly the whitelisted subset
      (is_superuser/is_staff/is_active + the five limits) via
      POST /apps/:id/users/:userId/save; the client bot's own row renders a
      nothing-to-manage note. User identity fields are now readonly in
      metadata and `_sanitizeData` skips readonly fields, so partial form
      saves can never wipe Discord-synced values
- [x] Settings section - the Configuration singleton rendered in-surface as
      grouped field cards (General/Discord/Console Security/Request
      Limits/Extras, unlisted fields fall through to Other), riding the same
      +field mixin, auto-save on change, toast in the takeover header;
      POST /apps/:id/save branches to the Configuration model for the self
      app. Sensitive keep-on-blank + __clear semantics unchanged
- [x] All info popups read-only: modal renders force readonly, the
      /settings save + delete routes and their UI (record form posts, Clone,
      Delete, Create New, Read Only badge, modal toast plumbing) are gone;
      search + pagination stay. Avatar/member/server-info/channel-gear flows
      unchanged, now guaranteed read-only
- [x] Settings sidebar + power-bar cog removed: toggle-settings routes,
      settingsLayout/settingsChannels/settingsButton(Opened)/settingsToggleClose
      templates and the sidebar/settings dir deleted (hash icon relocated to
      apps/sectionHashIcon.pug), settingsToggled banner branch dropped,
      userbox CSS pruned. The +field mixin moved to mixins/field.pug (the
      modal _form.pug is gone)
- [x] Onboarding CTA cutover: "Add your Discord bot token" now posts into
      the DiscoFlix Settings takeover (post-kind CTA) instead of opening the
      dead configuration modal
- [x] Takeover form fields now sit in .appFormCard containers styled like
      the popups' record cards (applies to the arr settings section too)
- [x] Settings surfaces rebuilt around hairline field rows (Nick feedback
      2026-07-12, second pass same day). The +field mixin now renders every
      field as a row - label and hint own the left, the control pins right
      sized to its expected input (switch, 110px number, 240px short text),
      while secrets and URLs stack a full-width control under the label.
      New optional `size` hint on field descriptors (metadata/manifests,
      threaded through getFormData) overrides the type default, so
      generated forms finally carry per-field width intent. Group dividers
      stay full-bleed across the surface (widescreen decoration - Nick
      liked that) while a padding formula centers each group's rail+card
      interior on a 1040px measure; the title rail is fixed 240px so labels
      never drift from their cards. Read-only popups ride the same row
      anatomy (value box flexes to half the row, full value in a hover
      title). Users section bounded to the same measure, cards fill it
      two-up. Fixed +field dropping value="0" (0 = unlimited now renders)

Remaining:

- [ ] M8 additions to THE live browser pass (merged with M7's item): badge
      click → overview lands w/ pill + banner "DiscoFlix"; hover cog →
      settings; problem dot appears when an app is unreachable and clears
      after fix; users search/paginate; toggle staff → chip + toast, identity
      survives; limits save; user popup from avatar is read-only; config
      save toasts and persists incl. blank-token keep + __clear; onboarding
      CTA enters settings takeover; reload inside DiscoFlix restores it;
      guild click backs out clean; arr settings/overview/queue regressions;
      settings rows look right at widescreen + pinched sidebar widths
      (controls pinned right and sized, token/URL stacked full width,
      hairlines between rows, group dividers full-bleed, interiors centered);
      zero-valued limits render 0; user popup rows show values half-row
      with hover title on truncation

## M9 - Library Search + The App Catalog (in progress)

Scope (Nick, 2026-07-12): Search & Add dissolves into the library - a rail
search bar (pinned where Recent Activity lives) drives the library section's
new search mode; search results get the same detail treatment as library
items (ephemeral until added); the app catalog grows by ten - every icon
staged in public/images gets a real manifest and client.

Built 2026-07-12 (fixture renders + stubbed-transport client checks only -
rides THE live pass below):

- [x] Search & Add section deleted (manifest sections, SECTION_LABELS,
      search.pug / searchResults.pug / appSearchRow.pug). The rail search
      bar replaces it: a 48px strip pinned over Recent Activity whose
      hairline sits level with the panel header's bottom edge; debounced
      3+ chars (or Enter to force) drops the takeover into the library
      section's search mode, clearing the box restores browsing, and an
      empty term from any other section/app is a 204 no-op. The input lives
      in the untouched right rail so term and focus survive every surface
      swap; the heartbeat feed push now swaps an inner #appFeedBody
      fragment so live feed updates can't stomp the input either
- [x] Library two ways: mode (browse listing | search results) x view
      (covers | detailed). Detailed rows reuse the old search-result
      anatomy (poster/title/overview/state chip) via mixins/browse.pug for
      both sources; covers stay the poster grid, search-result cards wear
      green (on disk) / blurple (in library) dots. View toggle in the
      section header, sticky per mode (core.apps.browseViews, in-memory by
      design); search defaults detailed, browse defaults covers; View More
      pages render in whatever view is current; detailed lists ride the
      1040px doc measure so ultrawide gets margins, not mile-long rows
- [x] Ephemeral detail: clicking an un-added search result opens the
      libraryDetail surface built from a live lookup
      (GET /apps/:id/lookup/:externalKey, ArrClient.normalizeLookupDetail
      prunes library-owned facts/file/seasons), "Not in library" pill, Back
      re-runs the term still in the rail input, and "Add to <app>"
      (add-media mode=detail) answers with the real detail view - actions
      unlocked - plus a header toast. Results already in the library open
      the real detail directly; backTo=search keeps the Back button honest
      and threads through the monitor/search verbs too
- [x] Multi-instance "Add to:" tabs moved into the search header - a tab
      re-runs the search inside the rival's takeover with the term riding
      along (appSearch enters cross-instance takeovers itself)
- [x] Ten new app types, each a real client on the baseClient contract:
      NZBGet (JSON-RPC, per-group + global pause/resume/delete, history),
      Deluge (web JSON-RPC, session-cookie cache, daemon auto-connect,
      2.x/1.x fallbacks), Transmission (RPC with the 409 CSRF handshake
      cached), ruTorrent (httprpc mode=list + raw XML-RPC for version and
      pause/erase), uTorrent (token.html + GUID cookie cache, status
      bitfield), Plex / Emby / Jellyfin (status + recently-added feeding
      the rail as 'added' rows, no queue), Jackett / NZBHydra2 (torznab/
      newznab caps as the apikey-gated status check). Picker gains Media
      Server (green) and Indexer (yellow) kind chips; overview hides the
      queue line for queue-less apps and tolerates version-less statuses;
      .env.example documents every new <TYPE>_<FIELD> seed
- [x] BaseClient.humanEta shared (qbit's local formatEta rides it now);
      arr normalizeLibraryItem carries overview for the detailed rows

Remaining:

- [ ] M9 additions to THE live browser pass (merged with M7/M8's item):
      rail search from every section lands in library search mode with
      focus + term intact; Enter forces short terms; clearing restores
      browse; the view toggle sticks per mode incl. View More pages;
      quick-Add flips the row in place; row click opens ephemeral detail,
      Add unlocks the real one w/ toast, Back returns to the same results;
      in-library results open real detail whose Back says Results;
      a heartbeat feed push mid-typing leaves the input alone; Add-to tabs
      hop instances with the term; each new app type adds from the picker,
      configures, Tests green, and its dot goes live; queue verbs move real
      downloads on nzbget/deluge/transmission/rutorrent/utorrent; plex/
      emby/jellyfin recently-added feeds paginate; jackett/hydra reject a
      bad key with a readable pill; stale active_section='search' rows fall
      back to Overview

---

## Feature Planning (unstaged - promote before working)

- EventLog DB transport + log viewer modal (model + readonly modal support exist; logging.js never wired prisma)
- Per-browser-session active server/channel - multi-user UI (today `State` is a global singleton, deliberately single-user)
- Chat history pagination / infinite scroll (`getChannelMessages` already has a `before` cursor)
- Media library browser (Media model + poster cache exist)
- Download-complete DM notifications to requesters (v2 feature)
- Mobile layout pass (`mobile.css` exists, unmaintained)
- Members pane phase 2: per-user presence + role grouping (pane itself shipped in M5 from tracked users)
- Message grouping: collapse consecutive same-author messages within ~7min like Discord (each message currently renders a full author header)
- Bot presence/status line config (playing/watching text)
- `!df status` / `/status` command - show the caller's open requests + live download state from the arr queue
- DM request support (`logMessageToInterface` skips DMs entirely; request flow + notifications are guild-channel-only)
- Re-arm arr queue watches on boot (monitor state is in-memory; open MediaRequests are orphaned by a restart)
- Root folder / quality profile selection per request (pipeline defaults to first root folder + first profile)
- Discord role → permission mapping (staff/admin are hand-set in the DiscoFlix Users section today; map guild roles onto them automatically)
- Perf: `logMessageToInterface` force-fetches the author from the Discord API on every message (`author.fetch(true)` busts cache); throttle or trust cache
- Season-level requesting for shows (request whole series only today; v2 allowed picking seasons)
- Logout button in the user-controls strip (`POST /logout` route already exists, no UI for it)
- Scoped ws emits, phase 2: per-bubble/per-channel oob swaps instead of container re-renders (`serverSortableContainer` still re-renders wholesale on every message)
- Library detail phase 2: per-episode tables for Sonarr seasons, interactive search (pick a release), edit quality profile/root folder, delete item
- Arr status dots in the userbox: likely obsolete - the orphaned `radarrButton.pug`/`sonarrButton.pug` were deleted in the M7 cleanup, and the app rail now ships per-instance heartbeat status dots + a Test Connection pill in app settings
- "Coming Soon" virtual channel: read-only feed rendered from the Radarr/Sonarr calendar endpoints as bot-style messages (releases this week/month) - gives every server a reason to open the console daily
- Dashboard request rows deep-link to the originating message in the chat mirror (jump to channel, scroll, flash the mentioned row)
- Live download ticker: slim strip above the chat input showing active queue progress (the ws push pipeline already feeds the dashboard; surface it in the chat)
- Per-guild ops stats inside the Server Info modal: requests this week, top requesters, quota usage per user
- Weekly digest the bot posts to a configured channel ("added this week / now available") - retention hook for end users
- Availability answers before requesting: check Media/library (later Plex/Jellyfin) and reply "already on the server" with a link instead of opening a request
- Scope expansion, someday: Lidarr/Readarr clients (`arrClient` is already service-generic) for music/book requests
- Keyboard accessibility pass: channel rows, gears, and avatars are click-only divs - needs `role="button"`, `tabindex`, and key triggers
- Self-host vendor assets (htmx, ws.js, hyperscript, sweetalert2, bootstrap, cooltipz, fonts all come from CDNs) - one `npm` vendor step, works offline, no supply-chain surprises
