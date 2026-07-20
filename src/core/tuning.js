// EVERY OPERATIONAL TUNABLE IN ONE REGISTRY - POLL CADENCES, TIMEOUTS, PAGE
// SIZES, CAPS, TTLS. DEFAULTS LIVE HERE; ADMIN OVERRIDES LIVE SPARSELY IN
// Configuration.tuning_json AND SURFACE ON THE DISCOFLIX SETTINGS PAGE.
//
// READS ARE SYNCHRONOUS (`tuning.value(key)`) AGAINST AN IN-MEMORY SNAPSHOT
// SO HOT PATHS (MESSAGE GROUPING, LOG WRITES) NEVER AWAIT A DB ROUND-TRIP.
// THE SNAPSHOT PRIMES AT BOOT, RE-READS WHEN A SAVE INVALIDATES IT, AND
// SELF-HEALS ON A SOFT TTL IN CASE THE ROW WAS EDITED BEHIND OUR BACK
// (PRISMA STUDIO / sqlite-web COUNT AS "BEHIND OUR BACK").
//
// DELIBERATELY NOT HERE: DISCORD PROTOCOL LIMITS (25 SELECT OPTIONS, 2000
// CHAR MESSAGES, EPHEMERAL TOKEN LIFETIMES), UNIT CONVERSIONS, CRYPTO
// PARAMETERS, AND COSMETIC CLIENT DELAYS - THOSE ARE FACTS, NOT PREFERENCES.

const GROUPS = [
  {
    label: 'Tuning: Requests & Downloads',
    blurb: 'How often queues are polled, how long watches run, and how big request-side pages and result lists get.',
    items: [
      { key: 'monitor_poll_seconds', label: 'Queue watch poll (s)', default: 15, min: 5, max: 300, description: 'How often active download watches poll the service queue' },
      { key: 'heartbeat_seconds', label: 'App heartbeat (s)', default: 60, min: 15, max: 3600, description: 'How often every configured app is health-checked for rail dots, ticker, and queue pushes' },
      { key: 'heartbeat_boot_delay_seconds', label: 'First heartbeat delay (s)', default: 5, min: 0, max: 300, description: 'Pause after boot before the first heartbeat sweep' },
      { key: 'queue_settle_ms', label: 'Queue settle delay (ms)', default: 300, min: 0, max: 5000, description: 'Wait after a queue action before re-reading the queue' },
      { key: 'selection_hard_cap_minutes', label: 'Selection hard cap (min)', default: 15, min: 1, max: 120, description: 'Absolute lifetime of a request picker, idle or not - the per-feature selection timeout still applies' },
      { key: 'requests_page_size', label: 'Requests page size', default: 20, min: 5, max: 200, description: 'Rows per page in the console requests pipeline' },
      { key: 'feed_page_size', label: 'Activity feed page size', default: 15, min: 5, max: 100, description: 'Entries per page in app activity feeds' },
      { key: 'search_result_cap', label: 'Service search cap', default: 20, min: 1, max: 100, description: 'Max results shown for an app service search' },
      { key: 'release_result_cap', label: 'Release list cap', default: 30, min: 1, max: 200, description: 'Max rows in the interactive release/indexer grid' },
      { key: 'feed_ttl_seconds', label: 'Feed cache TTL (s)', default: 60, min: 5, max: 3600, description: 'How long activity feeds are cached before a refetch' },
      { key: 'library_ttl_seconds', label: 'Library cache TTL (s)', default: 300, min: 10, max: 86400, description: 'How long app library listings are cached (they refresh in the background)' },
      { key: 'library_count_wait_ms', label: 'Library count wait (ms)', default: 1500, min: 100, max: 15000, description: 'How long a live library count is awaited before falling back to cache' },
      { key: 'unified_page_size', label: 'Unified library page size', default: 60, min: 10, max: 500, description: 'Titles per page in the unified library hub' }
    ]
  },
  {
    label: 'Tuning: Service Timeouts',
    blurb: 'HTTP deadlines for every connected service. Raise these for slow homelab hardware, lower them for snappier failure detection.',
    items: [
      { key: 'arr_http_timeout_seconds', label: 'Arr API timeout (s)', default: 10, min: 2, max: 120, description: 'Radarr / Sonarr / Lidarr request deadline' },
      { key: 'indexer_search_timeout_seconds', label: 'Indexer search timeout (s)', default: 90, min: 10, max: 600, description: 'Deadline for interactive release searches (indexers are slow)' },
      { key: 'media_server_http_timeout_seconds', label: 'Media server timeout (s)', default: 10, min: 2, max: 120, description: 'Plex / Emby request deadline' },
      { key: 'download_client_http_timeout_seconds', label: 'Download client timeout (s)', default: 10, min: 2, max: 120, description: 'qBittorrent / SABnzbd / NZBGet / Deluge / Transmission / uTorrent / ruTorrent deadline' },
      { key: 'indexer_http_timeout_seconds', label: 'Indexer app timeout (s)', default: 30, min: 5, max: 300, description: 'Jackett / NZBHydra2 request deadline' },
      { key: 'ai_request_timeout_seconds', label: 'AI request timeout (s)', default: 120, min: 10, max: 1200, description: 'Anthropic / OpenAI / Gemini reply deadline' },
      { key: 'ollama_request_timeout_seconds', label: 'Ollama request timeout (s)', default: 300, min: 10, max: 3600, description: 'Local models load slowly - Ollama gets its own deadline' }
    ]
  },
  {
    label: 'Tuning: Discord Mirror',
    blurb: 'The chat mirror and bot reply surfaces - history depth, grouping, refresh coalescing, and embed row counts.',
    items: [
      { key: 'history_page_size', label: 'History page size', default: 100, min: 20, max: 500, description: 'Messages fetched per page of mirror history' },
      { key: 'group_window_minutes', label: 'Grouping window (min)', default: 7, min: 0, max: 120, description: 'Same-author messages inside this window collapse into one block' },
      { key: 'author_profile_ttl_minutes', label: 'Author profile TTL (min)', default: 15, min: 1, max: 1440, description: 'How long fetched author accent colors are cached' },
      { key: 'author_profile_cache_max', label: 'Author cache entries', default: 500, min: 50, max: 10000, description: 'Max cached author profiles before old ones are evicted' },
      { key: 'guild_refresh_debounce_ms', label: 'Guild refresh debounce (ms)', default: 2000, min: 250, max: 30000, description: 'Guild events arrive in bursts - how long to coalesce before re-syncing' },
      { key: 'guild_refresh_max_wait_ms', label: 'Guild refresh max wait (ms)', default: 10000, min: 1000, max: 60000, description: 'Upper bound on coalescing - a steady burst still syncs this often' },
      { key: 'feature_rule_cache_ttl_seconds', label: 'Feature rule cache TTL (s)', default: 30, min: 0, max: 3600, description: 'How long resolved bot feature rules are cached (saves invalidate immediately)' },
      { key: 'status_embed_rows', label: 'Status embed rows', default: 10, min: 3, max: 25, description: 'Max rows in the /status reply' },
      { key: 'whatsnew_poster_rows', label: 'Whats-new poster rows', default: 5, min: 1, max: 10, description: 'Poster entries per whats-new page' },
      { key: 'whatsnew_compact_rows', label: 'Whats-new compact rows', default: 7, min: 1, max: 20, description: 'Compact entries per whats-new page' }
    ]
  },
  {
    label: 'Tuning: Console & Sessions',
    blurb: 'Console page sizes, upload limits, and how long logins and idle view sessions live.',
    items: [
      { key: 'users_page_size', label: 'Users page size', default: 20, min: 5, max: 200, description: 'Rows per page in the users section' },
      { key: 'logs_page_size', label: 'Logs page size', default: 50, min: 10, max: 500, description: 'Rows per page in the logs section' },
      { key: 'profile_request_rows', label: 'Profile request rows', default: 10, min: 3, max: 100, description: 'Requests listed in the profile modal' },
      { key: 'top_requester_count', label: 'Top requesters shown', default: 5, min: 1, max: 25, description: 'Leaderboard length on the server overview' },
      { key: 'quota_row_cap', label: 'Quota rows shown', default: 10, min: 1, max: 50, description: 'Per-user quota rows on the server overview' },
      { key: 'upload_max_mb', label: 'Upload cap (MB)', default: 8, min: 1, max: 100, description: 'Max attachment size sent from the console chat bar' },
      { key: 'login_session_ttl_days', label: 'Login session TTL (days)', default: 7, min: 1, max: 365, description: 'How long a console login lasts before re-authentication' },
      { key: 'stale_session_days', label: 'Stale session cutoff (days)', default: 60, min: 7, max: 3650, description: 'View sessions idle longer than this are swept' },
      { key: 'db_admin_page_size', label: 'DB admin page size', default: 50, min: 10, max: 500, description: 'Rows per page in the database section grid' },
      { key: 'db_admin_sql_row_cap', label: 'DB admin SQL row cap', default: 200, min: 10, max: 5000, description: 'Max rows the SQL console renders per query' }
    ]
  },
  {
    label: 'Tuning: AI',
    blurb: 'Reply budgets, context depth, and tool-loop bounds for the AI providers.',
    items: [
      { key: 'ai_max_tool_turns', label: 'Max tool turns', default: 6, min: 1, max: 25, description: 'Tool-use round trips an AI reply may take before answering' },
      { key: 'ai_discord_max_tokens', label: 'Discord reply tokens', default: 1024, min: 256, max: 16384, description: 'Max tokens for replies in Discord' },
      { key: 'ai_console_max_tokens', label: 'Console reply tokens', default: 2048, min: 256, max: 32768, description: 'Max tokens for replies in the console thread chat' },
      { key: 'ai_console_context_turns', label: 'Console context turns', default: 30, min: 2, max: 200, description: 'Conversation turns kept in console thread context' },
      { key: 'ai_discord_chunk_chars', label: 'Discord chunk size (chars)', default: 3400, min: 500, max: 3900, description: 'Long replies split into Discord messages of this size' },
      { key: 'ai_typing_refresh_seconds', label: 'Typing refresh (s)', default: 8, min: 3, max: 60, description: 'How often the typing indicator re-fires while a reply generates' },
      { key: 'ai_tool_search_cap', label: 'Tool search results', default: 8, min: 1, max: 50, description: 'Rows a search tool call returns to the model' },
      { key: 'ai_tool_list_cap', label: 'Tool list results', default: 15, min: 1, max: 100, description: 'Rows a list tool call returns to the model' },
      { key: 'ai_directive_max_chars', label: 'Directive length cap', default: 4000, min: 500, max: 50000, description: 'Max characters per custom directive' }
    ]
  },
  {
    label: 'Tuning: Logs & Cache',
    blurb: 'Retention for the DB log ledger and the on-disk image cache.',
    items: [
      { key: 'log_prune_every_writes', label: 'Log prune cadence (writes)', default: 200, min: 10, max: 10000, description: 'The log ledger is pruned every N writes' },
      { key: 'log_keep_newest', label: 'Log rows kept', default: 5000, min: 100, max: 1000000, description: 'Newest log rows retained by each prune' },
      { key: 'image_cache_retries', label: 'Image fetch retries', default: 3, min: 0, max: 10, description: 'Download retries (exponential backoff) for cached artwork' },
      { key: 'image_cache_timeout_seconds', label: 'Image fetch timeout (s)', default: 5, min: 1, max: 60, description: 'Deadline per artwork download attempt' },
      { key: 'image_cache_prune_days', label: 'Image cache age (days)', default: 7, min: 1, max: 365, description: 'Cached artwork older than this is pruned' }
    ]
  }
];

const ITEMS = GROUPS.flatMap(group => group.items);
const BY_KEY = new Map(ITEMS.map(item => [item.key, item]));

// SNAPSHOT STATE - PRIMED AT BOOT, INVALIDATED ON SAVE, SOFT-TTL SELF-HEAL
const SNAPSHOT_TTL_MS = 60 * 1000;
let prismaRef = null;
let overrides = {};
let loadedAt = 0;
let inflight = null;

function clamp(item, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(item.max, Math.max(item.min, Math.round(value)));
}

async function refresh() {
  if (!prismaRef) return;
  try {
    const row = await prismaRef.configuration.findFirst({ select: { tuning_json: true } });
    const parsed = row?.tuning_json ? JSON.parse(row.tuning_json) : {};
    const next = {};
    for (const [key, raw] of Object.entries(parsed)) {
      const item = BY_KEY.get(key);
      if (!item) continue; // RETIRED KEYS FALL AWAY SILENTLY
      const value = clamp(item, raw);
      if (value !== null && value !== item.default) next[key] = value;
    }
    overrides = next;
  } catch (err) {
    // A BAD ROW NEVER TAKES VALUES DOWN - DEFAULTS KEEP SERVING
    overrides = {};
  }
  loadedAt = Date.now();
}

module.exports = {
  GROUPS,
  ITEMS,

  // WIRED ONCE FROM CoreService - EVERYTHING BEFORE THIS SERVES DEFAULTS
  async init(prisma) {
    prismaRef = prisma;
    await refresh();
  },

  // SYNCHRONOUS BY DESIGN. UNKNOWN KEYS THROW - A TYPO'D KEY IS A CODE BUG,
  // NOT A CONFIG STATE, AND MUST NOT SILENTLY BECOME undefined MATH
  value(key) {
    const item = BY_KEY.get(key);
    if (!item) throw new Error(`Unknown tuning key: ${key}`);
    if (prismaRef && !inflight && Date.now() - loadedAt > SNAPSHOT_TTL_MS) {
      inflight = refresh().finally(() => { inflight = null; });
    }
    return overrides[key] ?? item.default;
  },

  // SAVE PATH: COERCE A POSTED FORM (tuning_<key> FIELDS) INTO THE SPARSE
  // OVERRIDE MAP. BLANK OR DEFAULT-VALUED FIELDS DROP THEIR OVERRIDE.
  overridesFromForm(body) {
    const next = { ...overrides };
    for (const item of ITEMS) {
      const raw = body[`tuning_${item.key}`];
      if (raw === undefined) continue; // FIELD NOT POSTED - LEAVE IT BE
      if (raw === '') { delete next[item.key]; continue; } // BLANK = RESET
      const value = clamp(item, raw);
      if (value === null) continue;
      if (value === item.default) delete next[item.key];
      else next[item.key] = value;
    }
    return next;
  },

  // TRUE WHEN THE POSTED FORM CARRIES ANY TUNING FIELD AT ALL
  formHasTuning(body) {
    return Object.keys(body || {}).some(key => key.startsWith('tuning_'));
  },

  async saveOverrides(core, next) {
    const json = Object.keys(next).length ? JSON.stringify(next) : null;
    await core.models.configuration.update({ tuning_json: json });
    overrides = next;
    loadedAt = Date.now();
  },

  // SETTINGS-PAGE VIEW MODEL - SHAPED LIKE buildConfigGroups OUTPUT SO
  // dfSettings.pug RENDERS THESE THROUGH THE SAME +field MIXIN UNTOUCHED
  settingsGroups() {
    return GROUPS.map(group => ({
      label: group.label,
      blurb: group.blurb,
      fields: group.items.map(item => ({
        key: `tuning_${item.key}`,
        type: 'number',
        label: item.label,
        description: item.description + (overrides[item.key] !== undefined ? ` (default ${item.default})` : ''),
        min: item.min,
        max: item.max,
        value: overrides[item.key] ?? item.default
      }))
    }));
  }
};
