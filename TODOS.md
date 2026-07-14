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

## M15 - Discovery & Retention (staged 2026-07-12, in progress 2026-07-13)

Built 2026-07-13 (14 fixture checks green - calendar normalization on stubbed
transports, digest schedule math, template renders - rides THE live pass):

- [x] Nick removed "Coming Soon" and Weekly Digest from scope intentionally,
      they were ridiculous and served no purpose whatsoever.
- [ ] Per-guild ops stats inside the Server Info popup: requests this week,
      top requesters, quota usage per user
- [ ] Unified media library browser (Media model + poster cache exist) with
      indexes that let every service link to a common media item by external
      id (tmdb/imdb/tvdb) or path
- [ ] Library detail phase 2: per-episode tables for Sonarr seasons,
      interactive search (pick a release), edit quality profile / root folder,
      delete item

## M16 - Platform Maturity (staged 2026-07-12)

- [ ] Per-browser-session active server/channel - multi-user UI (today `State`
      is a global singleton, deliberately single-user)
- [ ] Mobile layout pass (`mobile.css` exists, unmaintained)
- [ ] Lidarr/Readarr clients (`arrClient` is already service-generic) for
      music/book requests - manifests, season/album semantics, picker cards.
      This requires research done to confirm neither project are stale and/or
      abandoned. Find alternatives if that be the case.

## M17 - Requests & Interactions (staged 2026-07-12)

- [ ] Do research into discord most recent api, update project deps if needed.
- [ ] Rewrite the entire discord interaction flow with the end users to use
      innovative and highly intuitive UX that discord provides beyond just
      basic components. Improve visible structure of message responses and
      updates. Use embeds, decorators, imagery, and no emojis.
- [ ] Make the interaction features (movie, show, status, etc.) infinitely extendable
      via a standard app interface api, allowing us to open the discord bot
      and end user interactions up to other solutions in a non request context.

---

## Feature Planning (unstaged - promote before working)

(empty - everything promoted into M11-M16 on 2026-07-12)
