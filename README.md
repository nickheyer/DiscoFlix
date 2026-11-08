# DiscoFlix

One binary that searches, downloads, catalogs, transcodes, and takes requests for a home media collection, with a Discord-shaped interface over all of it.

## What it is

DiscoFlix v4 replaces Radarr, Sonarr, Lidarr, Readarr, Whisparr, Prowlarr, SABnzbd, qBittorrent, Overseerr, Tdarr, and a request bot with one Go process. Nothing it does is delegated to another self-hosted app. The only external services it talks to are media servers (Plex, Jellyfin, Emby) and public metadata, indexer, and AI endpoints.

This file is the specification. Every design decision lives here until code exists for it.

## Conceptual model

Every interface renders the same five nouns.

| Noun | Meaning | Discord mapping |
|---|---|---|
| Space | A context that people and automation share | A guild. Also the system space, one space per library, per plugin, per AI provider, per media server |
| Channel | An ordered stream inside a Space | A text channel. System spaces expose `#requests`, `#queue`, `#imports`, `#transcodes`, `#audit` |
| Message | One event in a Channel, authored by a User (humans, the bot, plugins, and agents are all Users) | A Discord message, mirrored both ways |
| Card | A typed, versioned payload attached to a Message, with live state | An embed or Components V2 container |
| Member | A User's presence in a Space with roles | A guild member |

Rules that follow from the nouns:

- Everything the system does is a Message with a Card in some Channel: a request, a grab, a download at 62%, an import, a transcode report, a login, a plugin install. The timeline is the audit log, the activity feed, and the notification source. There is no second event system.
- Discord is one transport of the timeline. The web UI is another. The RPC API and MCP are another. An approval clicked in Discord, in the console, or by an AI agent is the same state transition on the same Card.
- Cards are protobuf messages. The web client renders them natively, Discord renders them as Components V2, agents read them as structured tool output. A plugin that declares a new Card schema gets all three renderers.
- A Space backed by a Discord guild mirrors that guild's channels, members, messages, edits, deletes, reactions, and threads bidirectionally, as the v3 console did, with the request and user model layered on top of the chat rather than beside it.
- Presence, unread counts, and typing are real for every transport, because the console is a client of the same gateway the bot uses.

## One person, one User

A person is a single User row. Everything else hangs off it.

| Object | Shape | Purpose |
|---|---|---|
| User | id, display name, avatar, accent, flags | The only representation of a person, bot, plugin, or agent |
| Identity | (provider, subject, proof, linked_at) | `discord`, `plex`, `jellyfin`, `emby`, `oidc:<issuer>`, `local`, `email`; unique per (provider, subject) |
| Credential | (user, kind, secret hash or public key, last used) | `password`, `passkey`, `apikey`; several per User, each revocable |
| Membership | (user, space, roles) | Presence in a Space |
| Grant | relationship tuple | Answers "may U do V to W" for any object: a channel, a library, a media type, a plugin, another user |
| Quota | (subject, action, limit, window) | Requests per day, seasons per request, results per search, enforced in the capability layer so every transport obeys |
| ServerAccount | (user, media server, remote id, shares) | Provisioned, linked, and revoked from the User, so inviting someone creates their Plex or Jellyfin access and removing them revokes it |

A person who arrives through Discord, later signs into the portal with Google, then receives a Plex invite, is one row the whole time. Identity linking proves control on both sides before merging, and merges are reversible.

## Features

### Acquire
- Indexers: Newznab and Torznab natively, plus Cardigann YAML definitions (the Prowlarr and Jackett corpus) executed in-process, so hundreds of trackers and usenet indexers work on day one and definitions update without a release. Per-indexer limits, caching, failure backoff, health scoring, RSS sync.
- Usenet engine: multi-server NNTP over TLS, priority and backup servers, connection pooling, SIMD yEnc, streaming PAR2 verify and repair, RAR, 7z, and zip extraction, direct unpack during download, password lists, deobfuscation, duplicate detection, retention-aware server selection, history.
- Torrent engine: DHT, PEX, magnets, uTP, v2 and hybrid torrents, sequential and prioritized pieces, per-tracker seeding rules (ratio, time, private tracker etiquette), bandwidth schedules, interface and proxy binding with a kill switch.
- Release intelligence: name parsing for video, anime, music, books, comics, and adult releases; quality profiles and custom formats with TRaSH guide imports; explainable scoring; upgrade policies.
- Search: interactive and automatic, per media type, across every enabled indexer, from Discord, the web, the API, or an agent.

### Request
- Discord: slash commands, mentions, DMs, Components V2 cards with Approve, Deny, and quality pickers, threads for conversations, per-guild and per-channel feature rules, user-installable app.
- Web portal: the same request flow for people without Discord, with discover feeds, watchlist sync (Plex, Trakt), issue reporting, 4K separation, blacklists.
- Approval: tiers (auto, staff, admin), quotas, delegation, bulk actions, reminders.
- Lifecycle: one pipeline Card per request moving Requested, Decision, Searching, Grabbed, Downloading, Repairing, Importing, Transcoding, Available, Notified. Each step is durable across restarts and visible in every transport.
- Notifications: timeline-native plus Discord DM, web push, email, and shoutrrr-style service URLs.

### Catalog
- Canonical entities per media type (Movie; Series, Season, Episode; Artist, Release Group, Release, Track; Author, Work, Edition; Comic Series, Issue; Studio, Scene, Performer) with one universal external-ID crosswalk.
- Field-level provenance: every attribute records which source said it, when, and with what confidence. Per-field resolution policy (source priority, recency, user pin). User edits are pins and are never overwritten.
- Multi-source by default: TMDB, TVDB, IMDb datasets, Wikidata, Trakt, Fanart.tv, MusicBrainz, ListenBrainz, Cover Art Archive, Discogs, AniList, AniDB, Kitsu, anime-offline-database, OpenLibrary, Hardcover, Audnexus, ComicVine, Metron, MangaUpdates, StashDB, ThePornDB. Wikidata is the join hub. Every source is optional.
- Offline operation: a signed, periodically published crosswalk snapshot ships with the app and updates by delta, so ID resolution, matching, and naming never block on a third-party API being up or priced.
- AI reconciler: low-confidence matches (file to entity, request to entity, source conflict) go to a structured-output model call with the evidence attached. The verdict is a provenance record like any other.
- Artwork: fetched, deduplicated by content hash, transcoded to AVIF and WebP with thumbhash placeholders, cached locally.

### Library
- Generic ingress: point at any existing folder tree. Files are identified by content (ISCC video, audio, and text codes, AcoustID lookup for music, embedded identifiers for books) before names are trusted. Matches become provenance records.
- Organization: naming templates, hardlink, reflink, copy, or move, multi-root libraries, per-library media type and quality policy, orphan and duplicate detection.
- Smart transcoding: a policy engine that targets a perceptual quality score at minimum size (metric-targeted CRF search), detects hardware encoders, preserves HDR and Dolby Vision, applies audio and subtitle rules, estimates before running, schedules in windows, resumes after restarts, and posts before/after reports.
- Analysis: full technical index (codecs, bitrate, HDR format, audio layout, subtitles, chapters, loudness), health checks, size and bitrate analytics per library.
- Watching: filesystem events plus scheduled scans. Changes become Messages.

### Serve
- Plex, Jellyfin, Emby: server linking, library sync, now playing, recently added, account provisioning and library sharing driven by Grants, webhooks ingested as Messages, availability stamped back onto request Cards.

### People
- Login: Discord, Plex, Google, any OIDC issuer (Authentik, Authelia, Keycloak), passkeys, password, invite links.
- DiscoFlix is also an OIDC and OAuth 2.1 provider with PKCE, Client ID Metadata Documents, RFC 7591 registration, and device flow, so MCP clients, plugins, and other self-hosted apps authenticate against it.
- Authorization: relationship-based (Zanzibar model) over Spaces, Channels, libraries, media types, and plugins; quotas; API keys scoped like users; every decision auditable in the timeline.

### AI
- One capability registry, typed and schema-carrying, defines every action the app can take. The RPC API, MCP server tools, internal agent tools, Discord commands, and plugin host functions are all derived from it.
- Providers: Anthropic, OpenAI, Google, OpenRouter, Ollama and llama.cpp-compatible servers, Bedrock, Vertex. Per-door routing (commands, mentions, DMs, web chat, background jobs) with audience, caps, memory, and model choice.
- Uses: a conversational assistant in Discord and the web with tool use over the whole app; structured extraction of messy requests; metadata reconciliation; semantic search and recommendations over the library via local embeddings; natural-language automation rules compiled to policies.
- MCP server (streamable HTTP, OAuth 2.1) and MCP client (plugins and external servers contribute tools).
- Directives: composable system prompt blocks with template variables, per provider and per door, as in v3.

### Extend
- A plugin can add indexers, download handlers, metadata sources, media types, Card schemas, UI pages and panels, RPC endpoints, AI tools, event handlers, jobs, notification targets, storage tables, and settings.
- Sandboxed WebAssembly components in any language with a Component Model toolchain (Rust, Go, JS and TS, Python, C#, Zig) under capability manifests, and out-of-process native plugins for heavy or OS-bound work. Both speak the same typed interface.
- Plugins call the host, other plugins, and permitted system tools. Dependencies are declared and versioned.
- Install by dropping a file into the plugins folder or from a signed community registry. Hot reload. Each plugin owns a Space in the timeline.

### Operate
- One binary: headless on servers, desktop shell with tray and window when a display is present, `--headless` to force. Service install for systemd, launchd, and Windows services from the binary itself.
- Self-update with signature verification. Docker image. Homebrew, Scoop, winget, AUR.
- Observability: the timeline first, then slog JSON, OpenTelemetry traces and metrics, a Prometheus endpoint, pprof, and an in-app log viewer.
- Backups: online SQLite snapshot and restore, config export, encrypted secrets.
- Setup: first-run wizard, import from existing Radarr, Sonarr, Lidarr, Prowlarr, SABnzbd, qBittorrent, and Overseerr databases.

## Stack

Every version below was verified against the upstream release page on 2026-11-08. Pin exact versions. Renovate opens the bumps.

### Core

| Layer | Choice | Version | Why |
|---|---|---|---|
| Language | Go | 1.27.3, `go 1.27.0` in go.mod | Generic methods, `encoding/json/v2`, `uuid`, `testing/synctest`, `os.Root`, Green Tea GC, `GOEXPERIMENT=simd` for the yEnc and PAR2 kernels |
| RPC | connectrpc/connect-go | v2.0.2 | Plain-message handlers, in-process transport for the shell and plugins, HTTP/JSON and gRPC on one port, GET for side-effect-free methods |
| Schema | buf | v1.75.0, Protobuf Edition 2024 | One schema for Go, TS, Swift, Kotlin, OpenAPI, REST, MCP, and JSON Schema |
| Validation | bufbuild/protovalidate-go via connectrpc/validate-go | v1.4.0, v0.9.0 | Constraints live in the proto |
| REST | connectrpc/vanguard-go | v0.5.0 | `google.api.http` transcoding in-process for third-party integrations |
| OpenAPI | connectrpc/protoc-gen-connect-openapi | v0.30.0 | Generated per release |
| JSON Schema | bufbuild/protoschema-plugins | v0.6.0 | Tool schemas and settings forms from the same protos |
| Realtime | centrifugal/centrifuge embedded, centrifuge-js | v0.40.1, 5.8.0 | WebSocket with history, cursor recovery, presence, delta compression, SSE fallback, native SDKs |
| Database | SQLite via modernc.org/sqlite | v1.62.0 (SQLite 3.54.1) | CGO-free, FTS5, JSON, SESSION, RTREE, sqlite-vec built in, and the one driver Ent, DBOS, and OpenFGA all run on |
| ORM | ent/ent | v0.14.6 | Schema as Go, typed queries, hooks, privacy rules, native Atlas loader |
| Migrations | ariga/atlas library | v1.3.0, `ariga.io/atlas/sql/migrate` | Ent's `NamedDiff` writes versioned files through the Atlas library at dev time, the embedded directory is applied by the binary at boot with an in-tree revision store, no CLI needed |
| Workflows and jobs | dbos-inc/dbos-transact-golang | v1.8.0 | Durable workflows, queues with concurrency and rate limits, cron, messages, and events on SQLite, as a library |
| Vector search | sqlite-vec through modernc | v0.1.9 | Embeddings for semantic search and match candidates in the same file as the rows |
| Config | knadh/koanf | v2.4.1 | Layered file, env, flags, and database-backed settings |
| Logging | log/slog, lmittmann/tint | stdlib, v1.2.1 | JSON in production, colour in dev, `slog.NewMultiHandler` fan-out to the timeline |
| Telemetry | OpenTelemetry Go, prometheus/client_golang | v1.47.0, v1.25.0 | Traces, metrics, and logs are all stable; `/metrics`, pprof with `goroutineleak`, flight recorder, statsviz behind admin |
| HTTP/3 | quic-go | v0.65.0 | Alt-Svc upgrade when TLS is on; stdlib has no HTTP/3 |
| TLS | caddyserver/certmagic | current | ACME so push, service workers, and WebTransport work on LAN installs |
| Secrets | filippo.io/age | current | Settings secrets encrypted at rest with a machine-bound key |

### Identity and authorization

| Layer | Choice | Version | Why |
|---|---|---|---|
| Authorization | openfga/openfga embedded, SQLite datastore | v1.22.1 | Zanzibar relations over Spaces, Channels, libraries, plugins; CEL conditions carry quotas on the grant |
| OIDC provider and relying party | zitadel/oidc | v3.51.17 | Code with PKCE, device flow, token exchange, back-channel logout, both directions in one library |
| MCP auth | modelcontextprotocol/go-sdk `auth`, `oauthex` | v1.8.0 | RFC 9728 resource metadata, bearer middleware, Client ID Metadata Documents |
| Passkeys | go-webauthn/webauthn | v0.18.2 | Resident keys, attestation policies |
| Sessions | alexedwards/scs with a SQLite store | v2.9.0 | Revocable, listable per identity |
| Rate limits | go-chi/httprate, sethvargo/go-limiter | v0.16, v1.2.0 | HTTP and bot command paths |
| API keys | stdlib HMAC-SHA256 with pepper | stdlib | `dfx_<id>_<32 random bytes>` |

### Transports and integrations

| Layer | Choice | Version | Why |
|---|---|---|---|
| Discord | disgoorg/disgo | v0.20.0 | Components V2, modals, autocomplete, user-install apps, polls, shard manager, HTTP interactions |
| Plex | LukasParke/plexgo | v0.30.2 | PIN flow, home and managed users, server sharing, webhooks |
| Jellyfin | sj14/jellyfin-go | v0.5.0 (Jellyfin 12.4) | Generated client, user policies, library access |
| Emby | generated from the server swagger | Emby 4.10.2 | No maintained client exists; own adapter because auth differs from Jellyfin |
| Notifications | nicholas-fedor/shoutrrr, SherClockHolmes/webpush-go, wneessen/go-mail | v0.23.0, v1.4.0, v0.8.1 | Apprise-style URLs with egress control, VAPID push, SMTP |

### Acquisition

| Layer | Choice | Version | Why |
|---|---|---|---|
| NNTP | javi11/nntppool | v5.0.0 | TLS, provider tiers, article retry across providers, pipelining, retention, streaming decode |
| yEnc | mnightingale/rapidyenc | 2026-10-08 | Pure-Go AVX2 and NEON through `simd/archsimd` |
| NZB | javi11/nzbparser | v0.5.5 | Streaming parser |
| PAR2 | javi11/gopar-turbo API with an in-tree `archsimd` GF(2^16) kernel | v0.4.0 | Repair at SIMD speed with CGO off |
| RAR | nwaples/rardecode/v2 | v2.4.6 | RAR5, encrypted headers, multi-volume over `fs.FS`, which gives direct unpack |
| 7z | bodgit/sevenzip | v1.6.5 | AES, multi-volume, `fs.FS` |
| BitTorrent | anacrolix/torrent | v1.61.0 plus pinned pseudo-version | DHT, PEX, uTP, WebTorrent, web seeds, v2 and hybrid torrents, private rules, seekable reader |
| Indexer definitions | Prowlarr/Indexers and Jackett YAML, schema v11, executed by an in-tree engine | 581 definitions | Hundreds of sites on day one; the engine uses goquery, dlclark/regexp2 for .NET regex, a Go template dialect, FlareSolverr or Byparr, chromedp |
| Release parsing | dreulavelle/jhin, autobrr/rls | v0.8.0, v0.10.0 | jhin for video and anime with 46 fields, rls for music, books, audiobooks, comics |
| Custom formats | TRaSH-Guides JSON by `trash_id`, recyclarr YAML for user config, in-tree evaluator on regexp2 | pinned commit | 243 Radarr and 236 Sonarr formats import unchanged |
| Cloudflare | FlareSolverr or Byparr, chromedp | v3.5.2, v3.1.1, v0.23.0 | Same API, in-process browser for the rest |

### Catalog

| Layer | Choice | Version | Why |
|---|---|---|---|
| Bulk backbone | Wikidata extract, MusicBrainz dumps, anime-offline-database (cedya77), OpenLibrary dumps, TMDB ID exports | weekly | Resolution works with no live API |
| Live enrichment | own thin clients per source behind circuit breakers and budgets | in-tree | Every source is optional and rate-limited by terms |
| Snapshot delivery | TUF-signed `crosswalk.sqlite`, page deltas via sqlite3_rsync (caasmo/go-sqlite-rsync), any HTTP or IPFS mirror | go-tuf v2.3.1 | Signed, rollback-proof, mirrorable, CC0 and ODbL data only |
| Matching | in-tree Fellegi-Sunter with EM-learned weights, graph propagation, LLM set prompts | in-tree | Calibrated probabilities on every match edge |
| Artwork | gen2brain/avif, gen2brain/webp, galdor/go-thumbhash | current | CGO-free encoders, sha256-addressed blobs, inline placeholders |

### Library and transcoding

| Layer | Choice | Version | Why |
|---|---|---|---|
| FFmpeg | pinned ffmpeg and ffprobe subprocess from an in-house fork of FFmpeg-Builds | n9.0.2 with libvmaf+zimg, svt-av1, x265, vvenc, xpsnr, chromaprint, libplacebo, macOS target added | Crashes stay in a child, build stays CGO-free, hash-verified download on first run |
| Quality metric | VMAF v1 target, XPSNR second check | vmaf v3.2.1 | Temporal metrics with banding detection and HDR models |
| Video encoder | SVT-AV1 `--tune vq`, x265 for HEVC-only clients, vvenc opt-in | v4.3.0, 4.2, v1.14.0 | PSY work merged upstream in 4.0; hardware AV1 as the fast tier |
| CRF search | per-scene search seeded by a complexity predictor, pchip interpolation, at most 4 probes | in-tree, Av1an method | Minimum size at the target score |
| HDR | dovi_tool, hdr10plus_tool | 2.3.4, 1.7.2 | Profile 7 to 8.1, HDR10+ re-injection |
| Content identity | iscc/iscc-lib (ISO 24138) | v0.7.0 | Video-Code from MPEG-7 signatures, Audio-Code from Chromaprint, Text-Code, Instance-Code; similarity is Hamming distance |
| Books | pdfcpu, archive/zip and encoding/xml for EPUB OPF | v0.16.4 | ISBN-13 extraction with checksum validation |
| Filesystem watch | microsoft/typescript-go `internal/fswatch` vendored, charlievieth/fastwalk | 2026-08-14, v1.0.14 | Recursive, pure Go, fanotify, FSEvents without cgo, ReadDirectoryChangesW, kqueue; fastwalk for scans on network shares |
| Hardware detection | `ffmpeg -encoders` plus timed test encodes, jaypipes/ghw, NVML via ebitengine/purego | v0.27.0, v0.11.3 | Proves each encoder works before it is offered |
| Audio tags | go.senan.xyz/taglib | v0.15.0 | TagLib 2.1.1 as Wasm, read and write, CGO-free |
| Loudness | ffmpeg `ebur128` | n9.0.2 | ReplayGain 2.0 tags |

### AI

| Layer | Choice | Version | Why |
|---|---|---|---|
| Providers | anthropic-sdk-go, openai-go, googleapis/go-genai, ollama api, behind one `llm.Provider` shaped on Open Responses | v2.7.0, v3.96.0, v1.77.0, v0.40.15 | Official SDKs track features weekly; openai-go also covers OpenRouter, LM Studio, llama-server |
| MCP | modelcontextprotocol/go-sdk | v1.8.0 | Server and client, spec 2026-07-28 stateless plus 2025-11-25, conformance-tested |
| Schemas | google/jsonschema-go, santhosh-tekuri/jsonschema | v0.4.3, v6.0.3 | Struct to schema, per-provider keyword pass, local re-validation of every structured reply |
| Local embeddings | knights-analytics/hugot | v0.8.5 | Pure-Go backend for MiniLM-class models, ONNX Runtime behind a build tag |
| Local inference | hybridgroup/yzma | v1.32.0 | llama.cpp through purego, CUDA, Metal, Vulkan, no cgo; Ollama is a sidecar |
| Skills | Agent Skills format | agentskills.io | Plugins ship skill packs; `/llms.txt` served |

### Plugins

| Layer | Choice | Version | Why |
|---|---|---|---|
| Contract | WIT world `discoflix:host/plugin@1` | in-tree | Typed, versioned, language-neutral |
| Sandboxed host | partite-ai/wacogo on wazero | 2026-11-05, v1.12.0 | Pure-Go Component Model with resources and cross-component linking |
| Native host | bytecodealliance/wrpc over a per-plugin Unix socket or named pipe | v0.18.0 | Same WIT, streams and futures, calls in both directions |
| Toolchains | componentize-go, TinyGo wasip2, componentize-py, jco, wit-bindgen, wac | v0.5.3, v0.44.0, v0.25.1, v1.41.0, v0.63.0, v0.12.0 | Go, Python, JS and TS, Rust, C# and Zig via wit-bindgen |
| UI | sandboxed iframe per plugin origin, JSON-RPC over postMessage, Shopify/remote-dom | ext-apps v2.0.4 model, @remote-dom/core 1.12.1 | Plugin UI renders host components under host theme tokens |
| Distribution | OCI artifacts via oras-project/oras-go, wasm-pkg-tools layout, cosign and sigstore-go | v3.0.0, v0.16.1, v3.1.4, v1.4.0 | Any registry is a store; signer identity pinned per plugin |
| Capabilities | link-time grants plus parameterized `net`, `fs`, `exec`, `db` | in-tree | An import the user did not grant is never linked |

### Web and shell

| Layer | Choice | Version | Why |
|---|---|---|---|
| Framework | Svelte, SvelteKit with adapter-static | 5.57.3, 3.1.1, 4.0.1 | Runes update one text node per progress tick; smallest runtime on phones |
| Components | bits-ui, shadcn-svelte | 2.20.6, 1.8.0 | Accessible primitives styled to the Discord palette |
| Styling | Tailwind | 4.3.5 | Palette as `@theme` tokens |
| Lists | virtua, @tanstack/svelte-virtual | 0.54.2, 3.13.52 | Reverse and bidirectional timeline, grids and tables |
| Data | connect-es, protobuf-es, connect-query-core with @tanstack/svelte-query | 2.3.0, 2.17.0, 6.4.1 | Typed calls and cache from the protos |
| Build | Vite on Rolldown, Bun | 8.3.6, 1.4.4 | Fast builds, one package manager |
| PWA | @vite-pwa/sveltekit, VAPID push | 2.0.1 | Installable with push on iOS 16.4+, declarative push on 18.4+ |
| Desktop | Wails v3 with the `purego` tag, fyne.io/systray | v3.1.0, v1.12.2 | Tray, hide to tray, windowless lifetime, WebView2 and WebKitGTK; tray plus browser when a webview runtime is missing |
| Service | kardianos/service | v1.3.0 | systemd, launchd, Windows services, per-user services |
| Self-update | creativeprojects/go-selfupdate plus a sigstore-go validator | v1.7.0, v1.4.0 | GoReleaser checksums plus cosign bundle pinned to the release workflow identity |

### Tooling

| Tool | Choice | Version |
|---|---|---|
| Tasks | go-task via `go tool task` | v3.54.0 |
| Release | goreleaser (dockers_v2, homebrew_casks, scoop, winget, nfpm, AUR, nix, Syft SBOM, cosign bundles) | v2.20.0 |
| Lint | golangci-lint v2 config with gofumpt, gci, modernize | v2.15.0, v0.12.0 |
| Security | govulncheck, gremlins nightly | v1.9.0, v0.6.0 |
| Updates | Renovate for gomod, npm, actions, Docker; scheduled `buf dep update` | 44.x |
| CI | GitHub Actions, CGO-free matrix in one goreleaser job, shell builds on native runners | |
| License | AGPL-3.0 for the app, Apache-2.0 for `proto/`, `sdk/`, and example plugins | |

## Architecture

### Process

One Go process. Subsystems are supervised services started in dependency order and stopped in reverse:

```
store -> authz -> capabilities -> timeline -> gateway -> integrations -> engines -> ai -> plugins -> shell
```

A subsystem registers capabilities, Card schemas, and event handlers. No subsystem calls another except through a capability or the timeline. Built-in indexers, download handlers, metadata sources, and notifiers implement the same WIT interfaces external plugins do, compiled in rather than loaded, so the plugin ABI is exercised by the core on every request.

### Files on disk

| File | Owner | Contents |
|---|---|---|
| `app.db` | Ent and Atlas | Users, identities, spaces, channels, messages, cards, requests, library, claims, settings, FTS5 and vec0 indexes |
| `workflows.db` | DBOS | Workflow state, queues, schedules, messages |
| `authz.db` | OpenFGA | Authorization model and relationship tuples |
| `sessions.db` | scs | Web sessions, token hashes only |
| `crosswalk.sqlite` | snapshot pipeline | Read-only external-ID crosswalk, replaced by page deltas |
| `plugins/<id>/data.db` | the plugin, via Atlas library | Plugin-owned tables from the plugin's own schema |
| `blobs/<sha256>` | artwork store | Original and derived images |
| `bin/ffmpeg`, `bin/ffprobe` | binary manager | Hash-verified release of the FFmpeg fork |
| `config.yaml`, `secrets.age`, `secrets.key` | koanf, age | Bootstrap config; secrets encrypted with an X25519 key file created on first boot with mode 0600 |

Each file has exactly one migrator. Writes to `app.db` go through a single batching writer. A row that changes state and the Message that announces it commit in the same transaction. Authorization tuple writes are staged in an outbox table in `app.db` and applied to `authz.db` by a worker, because the embedded OpenFGA server cannot join the application transaction.

### Capability layer

```
proto service method
  -> descriptor (protoreflect) -> registry entry {name, input schema, output schema, scope, side-effect class, handler}
     -> Connect handler            (direct)
     -> REST route                 (vanguard)
     -> OpenAPI document           (protoc-gen-connect-openapi)
     -> MCP tool                   (go-sdk, built from the descriptor at startup)
     -> Discord command            (disgo, entries marked slash-safe)
     -> agent tool                 (same schema, same handler)
     -> plugin host import         (WIT function wrapping the entry)
     -> settings and request forms (JSON Schema)
```

One interceptor in front of every entry resolves the principal from a session, API key, OAuth token, Discord interaction, or plugin identity, then calls OpenFGA `Check(user, relation, object, context{used})`. Quotas are CEL conditions on the grant tuple and `used` is counted from `app.db` at check time. Side-effect classes are `read`, `write`, and `destructive`. A destructive entry invoked by an agent or a plugin pauses its workflow with `input_required`, posts an approval Card, and resumes on the Card interaction, so Discord buttons, the web, and MCP clients share one approve-and-resume path.

### Timeline

```
events(seq INTEGER PRIMARY KEY, space_id, channel_id, author_user_id, kind, card_type, card BLOB, reply_to, created_at)
events_fts(content)                   FTS5 with trigram tokenizer
```

`seq` is the subscriber cursor. After commit, the broadcaster fans out to Centrifuge channels named `space:<id>:channel:<id>`, to the Connect `WatchEvents(cursor)` stream used by plugins and MCP clients, and to plugin event imports. Clients resume from their last `seq`; Centrifuge history covers reconnects and delta-compresses 1 Hz progress updates. The Discord mirror is a consumer and a producer: gateway events become Messages, Messages authored elsewhere become Discord messages or Components V2 updates, and edits, deletes, reactions, and threads carry a Discord message id on the Message row so both directions stay idempotent.

Cards are `google.protobuf.Any` with versioned types such as `discoflix.card.v1.RequestPipeline`. Each type has a web renderer, a Discord Components V2 renderer, and a structured-output projection, registered together.

### Pipelines

Every multi-step operation is a DBOS workflow with idempotent steps keyed by the operation id. The request pipeline:

```
Requested -> Decision -> Searching -> Grabbed -> Downloading -> Repairing -> Importing -> Transcoding -> Available -> Notified
```

Engines (usenet, torrent, library, transcode) are long-lived services. A workflow step hands work to an engine and blocks on a DBOS message; the engine sends the message when the work is done or failed. Periodic work (RSS sync, library scans, snapshot deltas, update checks, metadata refresh) runs as DBOS cron workflows. A restart resumes every workflow from its last completed step and re-attaches to in-flight downloads by their on-disk state.

### Metadata graph

```
adapters    per-source client -> raw records (dumps, APIs, tags, fingerprints), breaker and budget each
raw store   append-only source_record(source, ext_id, payload, etag, fetched_at, license)
crosswalk   entity(id, kind) + ext_id(entity, namespace, value, p_match), seeded from the snapshot
matcher     T0 hard IDs -> T1 Fellegi-Sunter with EM-learned weights -> T2 graph propagation -> T3 LLM set prompts
claims      claim(entity, field, value, source, record, observed_at, confidence, rank), grow-only
policy      per kind and field: user pin > source priority > agreement count > recency, deterministic
resolved    materialized view with a per-field provenance trail shown in the UI
snapshot    weekly TUF-signed crosswalk.sqlite built from CC0 (Wikidata, MusicBrainz core) and ODbL (anime) data
peers       any mirror serves snapshots; claim sets merge as a state-based CRDT because claims only grow
offline     scans resolve from crosswalk plus claims; live APIs enrich and never gate
reconciler  low-probability clusters -> structured model call with the evidence -> claims with source=llm, low rank
review      user accept or reject writes source=user pinned claims and retrains the EM weights
```

Candidate pairs for the matcher come from FTS5 trigram search and vec0 nearest neighbours over title embeddings. TMDB, IMDb, and TVDB content stays inside each install under each source's terms; only CC0 and ODbL data enters the published snapshot. TVDB is treated as a source that may disappear, Trakt and Spotify are optional enrichers behind user-supplied keys.

### Plugins

```
plugin.toml        id, version, world "discoflix:host/plugin@1.x", deps (plugin ids plus semver), contributions
[capabilities]     net = ["https://api.tmdb.org"], fs = {"/media" = "ro"}, exec = ["ffmpeg -i *"], db = "own"
signature          cosign bundle, OCI digest pinned in the lockfile, consent stored per capability and re-asked on change
host imports       discoflix:host/{http, fs, exec, kv, db, events, log, capabilities}, linked only when granted
plugin exports     indexer, download-handler, metadata-source, media-type, notifier, ai-tool, job, rpc, card-renderer
plugin to plugin   host links A's import to B's export by WIT name at instantiation
composition        wac merges library components at build time; the host links the rest at runtime
native tier        same world served over wRPC on a per-plugin socket, not sandboxed, explicit trust at install
ui/                ESM bundle plus contribution points (route, panel, card renderer, settings JSON Schema)
ui runtime         sandboxed iframe per plugin origin, JSON-RPC over postMessage, remote-dom renders host components
```

`exec` grants wrap the managed ffmpeg and ffprobe, so plugins that process media stay in the sandbox. Plugin tables live in the plugin's own SQLite file and are applied from the plugin's schema with the Atlas library at load. Hot reload re-instantiates a component and replays its subscriptions from the cursor it last acknowledged.

### Shell

`--headless` always wins. Otherwise detection runs before any UI library initializes:

| OS | Headless when | Window when | Tray plus browser when |
|---|---|---|---|
| Windows | running as a service or in session 0 | WebView2 runtime present | WebView2 runtime missing |
| Linux | no reachable Wayland or X11 socket, or an SSH-forwarded display | GTK4 and WebKitGTK 6.0 load via dlopen | session bus present but WebKitGTK missing |
| macOS | session lacks graphic access (LaunchDaemon) | always | never |

Started interactively, server and shell share one process and the window loads `http://127.0.0.1:<port>/shell/session` with a single-use token that signs the first administrator in from loopback. Installed as a system service, the service runs headless and a per-user `discoflix tray` process, registered at login by `discoflix tray install` (XDG autostart, HKCU Run, LaunchAgent), opens the window against the service's loopback URL, polls `/healthz` for status, and runs the updater itself.

Artifacts: one `-tags purego,production` binary per OS and architecture that serves both desktop and headless, plus one fully static `-tags headless` Linux binary for containers.

### Smart transcode policy

1. Probe and fingerprint every file. Skip AV1 sources and any file whose predicted saving is under 15%.
2. Encode video with SVT-AV1 `--preset 4 --tune vq`, 10-bit, `--film-grain` when grain is detected.
3. Pass when each scene's mean VMAF v1 is at least 95 and its 5th-percentile frame is at least 90, model chosen by resolution and HDR. XPSNR is the second check.
4. Search per scene from the predicted CRF with at most 4 probes and pchip interpolation. Abort when the output reaches 90% of the source size.
5. Fast tier: a hardware AV1 encoder that passed its test encode, same search on `-cq` or `-global_quality`.
6. HDR: keep PQ, HLG, and mastering metadata. Pass Dolby Vision profiles 5 and 8 through `-dolbyvision`, convert profile 7 with `dovi_tool -m 2`, re-inject HDR10+ with `hdr10plus_tool`.
7. Audio: copy TrueHD, DTS-HD, and E-AC3 Atmos untouched. Keep existing lossy tracks at or below target. Otherwise Opus at 128k stereo, 256k 5.1, 384k 7.1.
8. Subtitles: copy every text and bitmap track into MKV, never burn in, convert to mov_text only for MP4 output.
9. Container: MKV with chapters, attachments, and tags. Write to a temp file, decode-check, compare duration, atomic rename.
10. Lossless music and books are indexed and never transcoded unless the user opts in per library.

### Web client

SvelteKit builds a static SPA with pre-compressed `.br` and `.gz` assets embedded with `//go:embed all:build`. The Go handler negotiates encoding, marks `_app/immutable/*` immutable, and serves `200.html` with no-cache as the SPA fallback. In dev, Vite proxies `/api` and the WebSocket to the Go server and a `dev` build tag serves from `os.DirFS`. The layout is the v3 console: left rail of Spaces, channel list, timeline, right rail of members or activity, status bar with the active download. Palette tokens: rail `#202225`, sidebar `#2f3136`, chat `#36393f`, input `#40444b`, hover `#4f545c`, text `#dcddde`, interactive `#b9bbbe`, muted `#72767d`, blurple `#7289da`, online `#43b581`, idle `#faa61a`, dnd `#f04747`. Noto Sans is embedded.

## Project structure

```
discoflix/
  go.mod  go.work  Taskfile.yml  .goreleaser.yaml  .golangci.yml  renovate.json  buf.yaml  buf.gen.yaml
  cmd/discoflix/                  main, subcommands: serve, tray, service, update, import, plugin
  internal/
    app/                          supervisor, lifecycle, dependency order
    capability/                   registry, interceptor, derivations (connect, rest, mcp, discord, agent, wit)
    timeline/                     events, cards, broadcaster, renderers
    identity/                     users, identities, linking, sessions, passkeys, api keys, invites
    authz/                        OpenFGA model, outbox, quota context
    oidc/                         provider and relying party, CIMD, RFC 7591, RFC 9728
    store/                        ent schema, generated client, Atlas migrations, writer, snapshot and restore
    workflow/                     DBOS setup, request pipeline, cron workflows
    gateway/                      Connect mux, vanguard, centrifuge, static handler, h3
    discord/                      gateway sync, mirror, Components V2 renderers, commands
    mediaserver/                  plex, jellyfin, emby adapters, provisioning
    indexer/                      newznab, torznab, cardigann engine, definitions sync, health
    release/                      parsing, quality profiles, custom formats, scoring
    usenet/                       nntp pool, queue, yenc, par2 kernels, unpack, post-processing
    torrent/                      client, seeding policy, trackers
    catalog/                      adapters, raw store, crosswalk, matcher tiers, claims, policy, snapshot, artwork
    library/                      ingress, content identity (iscc), watch, organize, naming, analysis
    transcode/                    ffmpeg manager, probe, hardware, policy engine, crf search, hdr
    ai/                           providers, router, doors, directives, agent loop, reconciler, embeddings, mcp server and client
    plugin/                       wacogo host, wrpc host, manifest, capabilities, registry client, ui bridge
    notify/                       shoutrrr, push, email, routing
    shell/                        wails app, tray, detection, service install, self-update
    telemetry/                    slog, otel, metrics, pprof
    config/                       koanf layers, secrets
  proto/discoflix/                buf module, Apache-2.0
    capability/v1  timeline/v1  card/v1  identity/v1  request/v1  catalog/v1  library/v1  acquire/v1  ai/v1  plugin/v1
  wit/discoflix/                  WIT packages for host and plugin worlds, Apache-2.0
  sdk/                            Apache-2.0
    go/                           own go.mod, generated protos and WIT bindings, test harness
    rust/                         crate with wit-bindgen bindings
    ts/                           package with jco bindings and the remote-dom UI kit
    py/                           componentize-py bindings
  plugins/
    builtin/                      first-party plugins compiled in (reference indexers, sources, notifiers)
    examples/{go,rust,ts,py}/     one of each, built in CI, installed in e2e tests
  web/                            SvelteKit app, Bun, embed.go
    src/lib/{api,timeline,cards,spaces,identity,theme,ui}
    src/routes/
  desktop/                        Wails assets and installers (NSIS, DMG), own go.mod
  snapshot/                       crosswalk build pipeline, TUF keys layout, mirror manifest
  deploy/                         Dockerfile, compose.yaml, systemd unit, launchd plist
  docs/                           design references and plugin authoring guide
  .github/workflows/              ci, release, snapshot, definitions-sync, renovate
```

## Build

```
go tool task gen            # protos, Ent code, JSON schemas
go tool task build          # web client plus the desktop-capable binary in bin/discoflix
go tool task build:headless # fully static Linux binary for containers
go tool task test           # Go and web tests
go tool task lint           # vet, buf lint, golangci-lint, svelte-check
go tool task cross          # all five targets into bin/cross
go tool task migrate:diff NAME=add_thing

bin/discoflix serve --data-dir ./data      # desktop shell when a display is present
bin/discoflix serve --headless --addr :5001
bin/discoflix service install [--user]     # systemd, launchd, or Windows service
bin/discoflix tray install                 # per-user login entry for the tray
bin/discoflix update --check
```

Release builds are produced by GoReleaser from a `v*` tag, signed with cosign through GitHub Actions, and published as archives, a distroless image, Homebrew, Scoop, and nfpm packages.

## Absolute requirements

1. One statically linked binary per target: linux/amd64, linux/arm64, windows/amd64, darwin/arm64, darwin/amd64, plus multi-arch Docker images. The headless build is CGO-free. The desktop build may dlopen native UI.
2. Go 1.27 minimum. The latest stable toolchain is adopted the week it ships.
3. One User model. No transport, plugin, or integration may create a second representation of a person.
4. One capability registry. Anything reachable from the web UI is reachable from RPC, MCP, Discord where it fits, and plugins, from the same definition and through the same authorization check.
5. Every long-running operation is a durable workflow that survives restarts and crashes and reports its state as a Card.
6. The app keeps working when every third-party API is down. Search, import, naming, and ID resolution fall back to the local metadata graph and snapshot, never to an error.
7. Schema changes ship as Atlas migrations embedded in the binary and apply at boot inside a pre-migration snapshot, so rollback is a file restore.
8. The plugin ABI is versioned and backward compatible within a major version. Core features are built on the same ABI plugins use.
9. Mobile is a first-class layout for every screen.
10. The Discord mirror is bidirectional and lossless for text channels: messages, edits, deletes, reactions, threads, and Card interactions.
11. Secrets are encrypted at rest. Authentication is on by default. The OIDC provider follows OAuth 2.1.
12. No silent degradation. A feature that cannot run reports why in the timeline and the UI, never a softened success.
13. Every external call (indexer, metadata, media server, AI) goes through one client layer with rate limiting, caching, circuit breaking, and provenance stamping.

## Non-goals

- DiscoFlix does not play or stream media. Plex, Jellyfin, and Emby remain the players.
- DiscoFlix does not proxy, wrap, or require Radarr, Sonarr, Lidarr, Prowlarr, SABnzbd, qBittorrent, or Overseerr. It imports from them once.
- DiscoFlix does not depend on a hosted DiscoFlix service. The plugin registry and the metadata snapshot feed are static, signed, mirrorable artifacts.

## Build order

Each phase ends with a binary that does everything listed, with nothing stubbed. The extension interfaces exist from phase 0 because built-in providers are the first plugins.

| Phase | Delivers | Done when |
|---|---|---|
| 0 Foundation | Repo, toolchain, protos, RPC server, SQLite with embedded Atlas migrations, capability registry, extension interfaces, timeline (Space, Channel, Message, Card), User and Identity, local and passkey login, web shell in the Discord layout, desktop and headless shell, service install, self-update, CI and release | A signed binary boots on all five targets, migrates, serves the UI, logs a user in, shows the system space timeline, and updates itself |
| 1 Mirror | Discord gateway, bidirectional guild, channel, member, message, reaction, and thread sync, Components V2 cards, slash commands, Discord login and identity linking | The v3 console experience is reproduced with live presence and unread counts, and a card interaction in Discord and the web is one state change |
| 2 Catalog | Metadata graph, external-ID crosswalk, offline snapshot pipeline, movie and series providers, artwork pipeline, entity search | A title typed in Discord or the web resolves to one canonical entity with field provenance while every provider is unreachable |
| 3 Acquire | Indexer layer with Cardigann engine, release parsing, quality profiles and custom formats, usenet engine, torrent engine, request pipeline workflows, approvals, quotas, notifications | A request in Discord becomes a file on disk through DiscoFlix alone, survives a restart mid-download, and reports every step as a Card |
| 4 Library and Serve | Generic ingress, content identity, organization and naming, media server linking, availability, account provisioning and sharing, now playing, request portal | An existing library imports with provenance, a new import appears in Plex and Jellyfin, and a non-Discord user requests from the portal and is notified |
| 5 AI | Provider layer, routing doors, directives, assistant with tool use, MCP server and client, structured extraction, reconciler, embeddings and semantic search, natural-language rules | Claude Code drives the app over MCP with OAuth, the Discord assistant completes a request end to end, and the reconciler resolves a conflicting match with a stored verdict |
| 6 Plugins | Component Model host, capability manifests, SDKs for Go, Rust, TypeScript, and Python, UI contributions, wRPC native host, registry format, signing, store UI | A plugin written in Rust and another in TypeScript each add an indexer, a Card, and a page without a core change, and a built-in provider runs unchanged on the external ABI |
| 7 Transcode | Technical index, policy engine, metric-targeted CRF search, hardware encoders, HDR and Dolby Vision preservation, scheduling, reports | A library analysis estimates savings, a scheduled job hits its quality target with the smallest file, and the report lands in `#transcodes` |
| 8 Breadth | Music, books, audiobooks, comics, anime, and adult specializations, importers from the *arrs and download clients, packaging for every channel | Each media type has search, request, acquire, import, and metadata with its own providers, and a Radarr plus Sonarr plus Prowlarr user migrates in one wizard run |

## Decision log

| Decision | Chosen | Rejected | Reason |
|---|---|---|---|
| SQLite driver | modernc.org/sqlite | ncruces/go-sqlite3, mattn, Turso tursogo | One driver for Ent, DBOS, and OpenFGA; DBOS reads modernc error types for busy handling; sqlite-vec and SESSION built in. ncruces ships SQLite's own vec1 and an HTTP range VFS and becomes the driver again the day DBOS and OpenFGA accept it |
| ORM | Ent | bob, sqlc, GORM, Bun | Native Atlas loader and schema-as-code; FTS5 and vec0 virtual tables and their sync triggers are hand-written in migration files because Atlas Community does not model them |
| Migration rollback | `VACUUM INTO` snapshot before each migration batch | Atlas `migrate down` | Down migrations are a paid Atlas feature; a file restore is the stronger rollback for SQLite |
| Durable execution | DBOS Transact Go | River, go-workflows, Temporal, Restate | Workflows, queues, cron, and messages in one library on SQLite; River's SQLite driver is marked early testing; go-workflows has one maintainer; the others need servers |
| Event bus | append-only SQLite table plus in-process broadcaster | embedded NATS JetStream | Events commit with the state they describe; NATS adds a second durable store and a dual-write problem |
| Realtime transport | embedded Centrifuge over WebSocket | Connect server streams, raw WebSocket, WebTransport | Six-connection limit on HTTP/1.1 LAN installs; history, recovery, presence, and delta compression come built; WebTransport lands later as a Centrifuge transport |
| RPC | Connect v2 with buf | gRPC, Twirp, GraphQL, tRPC, oRPC | Browser-native, in-process transport, HTTP/JSON and gRPC from one schema, REST and OpenAPI and MCP derived |
| MCP derivation | built at startup from proto descriptors | protoc-gen-go-mcp codegen | The codegen plugin pins Connect v1; descriptors already carry everything the tool schema needs |
| Authorization | OpenFGA embedded | SpiceDB embedded, Cerbos, Topaz, Keto, casbin | SpiceDB embedded only does Check and has no SQLite store; casbin has no relationship graph; OpenFGA runs in-process on the shared driver with CEL quota conditions |
| OIDC | zitadel/oidc v3 | go-oidc, fosite, Hydra | Only library covering provider and relying party, device flow, and token exchange; CIMD fetching and RFC 7591 are written in-tree |
| Discord | disgo | discordgo, arikawa | discordgo defaults to API v9 which rejects Components V2; disgo tracks the API within days |
| Plugin runtime | WebAssembly Component Model on wacogo | Extism, knqyf263/go-plugin, wasmtime-go, hashicorp/go-plugin alone | Extism's Go host has had no release since 2025-03 and an untyped interface; go-plugin is Go-only; wasmtime-go needs cgo and its component calls are unreleased; wacogo is pure Go with resources and cross-component linking. The host runtime is an interface so wasmtime-go can be swapped in behind the same WIT |
| Native plugins | wRPC over the same WIT | hashicorp/go-plugin | One contract for both tiers; go-plugin's handshake and restart design is reused |
| Plugin UI | sandboxed iframe with JSON-RPC and remote-dom | in-process module federation | Grafana deprecated its in-process frontend sandbox in 13.3; iframes are the model MCP Apps standardized |
| Plugin registry | OCI artifacts signed with cosign | Warg, wa.dev | Warg is archived and its work moved to OCI; any registry becomes a store |
| FFmpeg | managed subprocess from an in-house FFmpeg-Builds fork | go-astiav | cgo blocks CGO_ENABLED=0 builds and a libav crash would take the server down; the fork adds macOS and libvmaf with zimg for HDR models |
| Quality metric | VMAF v1 with XPSNR check | SSIMULACRA2, Butteraugli | Image metrics lack a time dimension and need VapourSynth; VMAF v1 has HDR models and CAMBI |
| Encoder tuning | SVT-AV1 `--tune vq` | SVT-AV1-PSY, `--tune vmaf` | PSY is archived and merged upstream; tuning for the judging metric would game the search |
| Content identity | ISCC (ISO 24138) via iscc-lib | pHash of keyframes, TMK, PDQ | A standard with video, audio, text, and instance codes in one pure-Go library |
| Filesystem watch | typescript-go `internal/fswatch` vendored | fsnotify, rjeczalik/notify | fsnotify still has no recursive watch, polling, or fanotify; the vendored package has all of them without cgo |
| Release parsing | jhin plus autobrr/rls | moistari/rls alone, go-ptn | jhin matches PTT on 1,156 titles with anime and adult fields; rls covers music, books, comics |
| Indexer engine | in-tree Cardigann v11 engine | importing autobrr/harbrr | harbrr is GPL-2.0 and alpha, and proves parity is reachable; definitions are consumed as data |
| PAR2 | gopar-turbo API with an in-tree archsimd GF(2^16) kernel | par2cmdline-turbo subprocess, cgo ParPar | Repair stays in-process and CGO-free at SIMD speed |
| Metadata backbone | bulk dumps plus a signed weekly crosswalk | live TMDB and TVDB per lookup | TVDB is rated endangered, Trakt is VIP-gated, TMDB caps caching at six months; the backbone is CC0 and ODbL data that cannot be revoked |
| Entity resolution | Fellegi-Sunter in Go, graph propagation, LLM set prompts | LLM per pair | Pairwise model calls cost thousands of times more than a learned linker; LLM-CER clusters in one prompt for the residue |
| LLM framework | official SDKs behind one interface | eino, genkit, langchaingo, fantasy | Frameworks lag the SDKs by months and hide cache control, thinking budgets, strict tools, and batch |
| Vector store | sqlite-vec through modernc | chromem-go, usearch, external DB | Same file as the rows and the same driver; vec1 is the upgrade path once modernc compiles it |
| Local inference | yzma via purego | embedding Ollama | Ollama cannot run in-process; yzma loads llama.cpp without cgo |
| Desktop shell | Wails v3 `purego` | glaze, energy, Fyne, Gio | Tray, multi-window, hide to tray, and a CGO-free tag; glaze has no Linux tray; Fyne and Gio cannot host a web UI |
| Frontend | Svelte 5 and SvelteKit 3 | React 19 with TanStack, Solid 2, Vue 3.5 | Smallest runtime for a phone-first timeline that updates every second; React is the alternative if connect-query hooks ever matter more |
| Package manager | Bun | pnpm, npm | One fast tool for install, scripts, and tests |
| Config | koanf v2 | viper | viper has had no release since 2025-09 |
| License | AGPL-3.0 app, Apache-2.0 proto, SDK, examples | MIT, GPL-3.0, FSL | Grafana's model: network copyleft on the app, permissive SDK so plugin authors choose their own license |

