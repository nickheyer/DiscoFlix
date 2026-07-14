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

> See `CHANGELOGS.md` for completed stages/tasks

## M15 - Discovery & Retention (staged 2026-07-12, built 2026-07-13)

Built 2026-07-13/14 (4 fixture scripts green - seeded guild stat math, unified
merge/degraded-service/page filters, arr client verbs on stubbed http, and
every new template render + route order - rides THE live pass):

- [x] Nick removed "Coming Soon" and Weekly Digest from scope intentionally,
      they were ridiculous and served no purpose whatsoever.
- [x] Per-guild ops stats inside the Server Info popup: requests this week,
      top requesters, quota usage per user - opt-in `getOpsPanels` hook on the
      model rides the generic settings-modal pipeline, quota math mirrors
      limits.js exactly (rolling 24h across every guild, admins exempt, 100%
      bars go red)
- [x] Unified media library browser (Media model + poster cache exist) with
      indexes that let every service link to a common media item by external
      id (tmdb/imdb/tvdb) or path - new Library section on the DiscoFlix
      takeover merges every serving instance's listing (id keys kind-scoped,
      imdb/path global, title+year fallback), Media ledger joins in by the
      same keys (new tmdb/tvdb/path indexes, migration
      `m15_media_link_indexes`) for Requested chips + cached-poster fallback;
      kind tabs w/ counts, filter box, covers/detailed toggle, View More
      pagination, per-item source chips jump into each service's own detail
      (from=hub keeps Back honest), proxied art preferred over LAN-only urls
- [x] Library detail phase 2: per-episode tables for Sonarr seasons (lazy
      season expanders, file quality/size joined in, Unaired/Missing states),
      interactive search (pick a release - arr /release sweep on a 90s
      timeout, rejected sinks w/ reasons on the chip, per-movie / per-season /
      per-episode scopes, grabs go back through the arr), edit quality
      profile / root folder (Manage panel; root moves recompute path and only
      move files on an explicit checkbox), delete item (danger confirm modal,
      deleteFiles + list-exclusion opt-ins, response restores whichever
      takeover surface the operator is on)

## M16 - Platform Maturity (staged 2026-07-12, built 2026-07-14)

- [x] Per-browser-session active server/channel - multi-user UI (today `State`
      is a global singleton, deliberately single-user) - BUILT 2026-07-14:
      `ViewSession` rows keyed by a df_view cookie (middleware mints/resolves,
      ctx.viewState = the row merged with global discord_state so every
      template's `state` local kept its shape - zero template edits), State
      shrank to discord_state (migration `m16_view_sessions`), per-server
      channel picks ride a session JSON map with the server row as global
      fallback, sockets carry their session id from the upgrade cookie, and
      every emit site went per-view (`emitPerView`/`emitToSessions`):
      refreshUI, guild syncs, power flips, heartbeat rails + takeover pushes,
      message rows only to sessions viewing that exact channel, badges only
      where they changed (unreads stay global, accrue only when NO connected
      session saw the message), chat relay + jump deep links use the acting
      session. 10 integration fixtures green on a mini-core w/ fake sockets
      (viewed/unviewed/self routing, pick persistence, per-view chrome/rails,
      badge exception rules)
- [x] Mobile layout pass (`mobile.css` exists, unmaintained) - REBUILT
      2026-07-14: mobile.css now imports LAST (its overrides used to lose
      cascade ties to apps/modals css), sidebar toggle is a real drawer
      (expanded = rail + channels own the phone, collapsed = the guild rail
      yields its 72px and content goes full-bleed), members/activity rail
      hidden on phones, 100dvh viewport, touch-sized channel rows, poster
      grid/detail hero/season + episode tables/long rows all get 768/640/480
      tiers (grid column counts track hidden cells). Verified in headless
      chromium at 375x812 + 1280x800 against the real rendered index.pug
      (drawer geometry, no horizontal scroll, desktop untouched)
- [x] Lidarr/Readarr clients (`arrClient` is already service-generic) for
      music/book requests - manifests, season/album semantics, picker cards.
      This requires research done to confirm neither project are stale and/or
      abandoned. Find alternatives if that be the case.
      RESEARCH VERDICT (2026-07-14): Lidarr is ALIVE (v3.1.2 Mar 2026,
      biweekly cadence) - BUILT. Readarr is RETIRED (Goodreads killed its
      metadata; official announcement, wiki marks everything Retired) -
      SKIPPED; alternatives assessed: Bookshelf (community fork, too young to
      bet installs on), LazyLibrarian (maintained but a non-arr API = its own
      project), rreading-glasses (duct tape for existing installs) - books
      moved to Feature Planning to re-evaluate when Bookshelf matures.
      LIDARR BUILD: LidarrClient on the arr contract with ALBUMS as the
      request/library/watch unit (resource 'album', api v1 via a new
      `apiVersion` hook, `lidarr:` mbid lookups, add POSTs the album w/ its
      artist payload + the lidarr-only metadata profile - third
      instanceOption select), Media gained musicbrainz_id (+index, migration
      `m16_media_musicbrainz`) riding upsert/findByResult/ledger, /music
      slash + music/album/artist prefix aliases auto-register, request embed
      gets Artist/Type/Released/Tracks fields, unified browser grew the
      music kind (mb merge keys, conditional Music tab), music note poster
      fallbacks, official svg vendored, env seeds documented. Album detail =
      monitor + album search verbs; artist-level edit/delete stays in Lidarr
      (capabilities off). 10 stubbed-transport + ledger + template fixtures
      green - rides THE live pass (needs a real Lidarr once)

## M17 - Requests & Interactions (staged 2026-07-12, built 2026-07-14)

Built 2026-07-14 (4 fixture suites green - 49 checks: bump wiring, full
picker/season/confirm walks, scoped library renders, roster sync + access-ask
flow on a throwaway db copy - rides THE live pass; the bump changed the
login/runtime path so the first live boot after this matters most):

- [x] Do research into discord most recent api, update project deps if needed.
      RESEARCH DONE 2026-07-14: discord.js v15 is still PRE-RELEASE; v14
      stable line is 14.26.x while we pinned 14.17.3. BUMPED to 14.26.5 -
      conformance was small because the code was already on v14 builder
      names: ephemeral option -> flags MessageFlags.Ephemeral (2 sites),
      generateInvite -> OAuth2Scopes.Bot + BigInt permissions, and
      Events.ClientReady rides the enum so the 'clientReady' rename came
      free. Zero deprecation warnings across every fixture run.
- [x] Rewrite the entire discord interaction flow with the end users to use
      innovative and highly intuitive UX that discord provides beyond just
      basic components - BUILT on Components v2: every bot surface is now an
      accent-colored Container (interactions/ui.js toolkit - sections w/
      poster thumbnails, separators, subtext meta strips, media galleries,
      progress bars, no emojis) behind IsComponentsV2 (no content/embeds
      anywhere). Request picker = poster section + facts strip + jump select
      + button rows + footer; season picker matches; every outcome is a
      poster card (ok/warn/danger accents); status got per-request blocks w/
      live progress bars off the queue cache; monitor grabs post ONE live
      download card that EDITS IN PLACE per tick (change-only frames, green
      100% settle on import, amber on stall) plus mention announces; console
      verdicts match. The chat mirror keeps up: DiscordMessage.components
      column (migration m17_message_components) persists CV2 JSON, a
      recursive messageComponents.pug renders containers/sections/galleries/
      inert control chips, markdownLite learned ### headings and -# subtext.
- [x] Make the interaction features (movie, show, status, etc.) infinitely extendable
      via a standard app interface api - BUILT: src/core/bot/interactions is
      a registry of defs { id, slash, options, aliases, ephemeral, available,
      run } - request defs generate per content type off the manifest
      registry, status/help are built-ins, and MANIFESTS contribute their own
      via `interactions: [...]` (registry.interactionDefs() merges by id and
      pools serving instances across app types, availability = some
      enabled+configured instance). One dispatcher normalizes slash + prefix
      (shared user sync, role grants, option parsing off the def), slash
      registration and the help card build themselves from the registry.
      Proof in a non-request context: /whatsnew (+ `new`/`latest` aliases),
      shipped by the plex/emby/jellyfin manifests off their normalized
      recently-added feeds - zero bot-core edits.

## M18 - Owner Asks (staged + built 2026-07-14)

- [x] Per-app library views become filtered views of the unified library
      component (Nick: the split designs were inconsistent) - getUnifiedPage
      grew scopeAppId (same merged entries narrowed to one instance's
      holdings, primary source remapped so cards open THIS app's detail,
      errors scoped, presentKinds ignores the term so tabs don't flap),
      /apps/:id/unified[+/page/:n] dropped the discoflix gate, appSurface
      renders dfLibrary for every browse mode (search mode keeps the live
      results surface + add-to tabs), back-links: hub -> from=hub, scoped ->
      from=library. Old per-app listing path deleted (getLibraryPage,
      libraryCards.pug, libraryBrowseRow, /apps/:id/library/page route);
      kind tabs now presence-driven (single-kind scopes hide the row).
- [x] User aggregation + whitelist flow overhaul - the bot now knows every
      member it serves, not just the ones who have spoken: roster sync
      (discord/userSync.js) runs on ready and rides the guild-event debounce,
      bulk-creates rows, refreshes drifted profiles, applies grant-only role
      promotions, and makes guild links EXACTLY match Discord (leavers
      unlink, rows + request history survive). One write path for every
      sighting: user.syncFromDiscord (message mirror, slash, prefix) keeps
      profiles fresh (DM-only drift fixed), stamps last_seen_at, connects
      known guilds. Whitelist wall became a flow: a denied ask stamps
      access_requested_at (first-ask-wins, wording distinguishes new vs
      pending), the console Users section grew audience tabs
      (People/Bots/Wants access/All + counts, people default, asks sort
      first), WANTS ACCESS chip + "seen Xm ago" on cards, and any grant
      (console save, mapped role, sync) settles the ask. Dead user model
      helpers deleted; migration m17_user_aggregation.

---

## Feature Planning (unstaged - promote before working)

- Book requests, revisited: Readarr retired mid-2025 (metadata gone). Watch
  the Bookshelf fork for maturity, or scope a LazyLibrarian client (maintained
  DobyTang fork, but its own non-arr API). Re-evaluate before promoting.
