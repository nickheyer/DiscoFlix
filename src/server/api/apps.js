// THE APP TAKEOVER SURFACE (nzb360-STYLE PSEUDO-GUILDS): CLICKING A RAIL
// BUBBLE SWAPS THE WHOLE CONSOLE TO THE APP'S SECTIONS (QUEUE/LIBRARY/...)
// USING THE SAME SLOT-SWAP FRAGMENTS THE SETTINGS SIDEBAR ALREADY PROVED.
const _ = require('lodash');
const { buildOverviewData } = require('./appOverview');
const { buildBotMatrix } = require('./botMatrix');
const { version: DISCOFLIX_VERSION } = require('../../../package.json');

// RAIL VIEW MODEL - EVERY INSTALLED INSTANCE RENDERS A BUBBLE
async function buildAppRail(core, state = null) {
  return core.apps.getRailViewModel(state);
}

// ── TAKEOVER VIEW MODELS ─────────────────────────────────────────────────

// THE USER FIELDS THE CONSOLE MAY EDIT - EVERYTHING ELSE IS DISCORD-SYNCED
// AND RENDERS READ-ONLY (SEE metadata.js)
const USER_MUTABLE_FIELDS = [
  'is_superuser',
  'is_staff',
  'is_active',
  'is_whitelisted',
  'max_requests_in_day',
  'max_results',
  'max_seasons_for_non_admin',
  // MUST RIDE EVERY CARD SAVE - safeUpdateOne's FULL-FORM SEMANTICS WOULD
  // OTHERWISE BLANK NOTES ON ANY OTHER FIELD'S EDIT
  'notes'
];
const USERS_PAGE_SIZE = 20;
const LOGS_PAGE_SIZE = 50;
const LOG_LEVELS = ['error', 'warn', 'info'];

// CACHED IMAGES ARE STORED AS BARE RELATIVE PATHS - SERVE THEM ROOT-RELATIVE
function rootRelative(path) {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `/${String(path).replace(/^\/+/, '')}`;
}

// AUDIENCE FILTERS FOR THE USERS SECTION - PEOPLE ARE THE DEFAULT (THE END
// USERS THE BOT SERVES), BOTS SIT BEHIND THEIR OWN TAB, OPEN ACCESS ASKS
// GET A DIRECT LENS
const USER_FILTERS = {
  people: { is_bot: false },
  bots: { is_bot: true },
  access: { access_requested_at: { not: null }, is_whitelisted: false, is_superuser: false, is_staff: false },
  all: {}
};

function lastSeenLabel(timestamp) {
  if (!timestamp) return null;
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = ms / 60000;
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  const days = Math.floor(minutes / (60 * 24));
  return days < 365 ? `${days}d ago` : `${(days / 365).toFixed(1)}y ago`;
}

// ONE USERS PAGE FOR THE SELF APP'S USERS SECTION - ROW + METADATA-DRIVEN
// FIELD DESCRIPTORS SO THE +field MIXIN RENDERS THE EDITABLE SUBSET. OPEN
// ACCESS ASKS ALWAYS SORT FIRST - THEY ARE THE THING WAITING ON AN ADMIN.
async function buildUsersPage(core, search = '', page = 1, filter = 'people') {
  const wantFilter = USER_FILTERS[filter] ? filter : 'people';
  // THE EXACT-ID ARM LETS THE PROFILE MODAL'S "OPEN IN USERS SECTION" LINK
  // LAND ON ONE CARD BY SNOWFLAKE - contains WOULD NEVER MATCH IT
  const searchWhere = search
    ? { OR: [{ username: { contains: search } }, { display_name: { contains: search } }, { id: search }] }
    : {};

  const [raw, ...countValues] = await Promise.all([
    core.prisma.user.findMany({
      where: { ...searchWhere, ...USER_FILTERS[wantFilter] },
      orderBy: [
        { access_requested_at: { sort: 'desc', nulls: 'last' } },
        { is_client: 'desc' },
        { username: 'asc' }
      ],
      skip: (page - 1) * USERS_PAGE_SIZE,
      take: USERS_PAGE_SIZE + 1
    }),
    ...Object.keys(USER_FILTERS).map(key =>
      core.prisma.user.count({ where: { ...searchWhere, ...USER_FILTERS[key] } })
    )
  ]);
  const counts = Object.fromEntries(Object.keys(USER_FILTERS).map((key, index) => [key, countValues[index]]));

  return {
    rows: raw.slice(0, USERS_PAGE_SIZE).map(row => ({
      row: {
        ...row,
        avatar_url: rootRelative(row.avatar_url),
        lastSeenLabel: lastSeenLabel(row.last_seen_at),
        // HANDS ONLY GO UP WHEN A GATE ACTUALLY DENIED SOMEONE, SO THE
        // STAMP ALONE (MINUS SETTLED GRANTS) KEEPS THE CHIP MEANINGFUL
        wantsAccess: !!row.access_requested_at
          && !row.is_whitelisted && !row.is_superuser && !row.is_staff
      },
      fields: core.models.user.getFormData(row)
    })),
    hasMore: raw.length > USERS_PAGE_SIZE,
    page,
    search,
    filter: wantFilter,
    counts
  };
}

// ONE PAGE OF EventLog ROWS FOR THE SELF APP'S LOGS SECTION - NEWEST FIRST,
// OPTIONAL LEVEL + TEXT FILTERS, VIEW-MORE PAGINATION LIKE EVERY OTHER LONG
// LIST. total RIDES ALONG SO THE TOOLBAR CAN SAY HOW DEEP THE MATCH RUNS.
async function buildLogsPage(core, level = '', page = 1, search = '') {
  const where = {};
  if (LOG_LEVELS.includes(level)) where.level = level;
  if (search) {
    where.OR = [
      { message: { contains: search } },
      { metadata: { contains: search } }
    ];
  }
  const [raw, total] = await Promise.all([
    core.prisma.eventLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * LOGS_PAGE_SIZE,
      take: LOGS_PAGE_SIZE + 1
    }),
    core.prisma.eventLog.count({ where })
  ]);
  return {
    rows: raw.slice(0, LOGS_PAGE_SIZE).map(row => {
      const stamp = new Date(row.timestamp);
      return {
        ...row,
        when: `${stamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${stamp.toLocaleTimeString('en-US', { hour12: false })}`
      };
    }),
    hasMore: raw.length > LOGS_PAGE_SIZE,
    page,
    level: LOG_LEVELS.includes(level) ? level : '',
    search,
    total
  };
}

// CONFIGURATION FORM GROUPS - EVERY EDITABLE FIELD LANDS IN A NAMED GROUP,
// UNLISTED NEWCOMERS FALL THROUGH TO 'Other' SO NOTHING SILENTLY VANISHES
// BOT BEHAVIOR (LIMITS, ACCESS, FEATURE TOGGLES, PREFIX, PRESENCE, ROLE
// MAPPING) LIVES ON THE DISCORD BOT TAB NOW - ONLY IDENTITY/INFRA REMAINS
const CONFIG_FIELD_GROUPS = [
  { label: 'General', blurb: 'What your media server goes by.', keys: ['media_server_name'] },
  { label: 'Discord', blurb: 'The bot token that connects DiscoFlix to your Discord servers. How the bot behaves and who may use it lives on the Discord Bot tab.', keys: ['discord_token'] },
  { label: 'Console Security', blurb: 'Password-protect this console.', keys: ['admin_password'] },
  { label: 'Extras', blurb: 'Nice-to-haves and diagnostics.', keys: ['is_debug'] }
];

function buildConfigGroups(formData) {
  const editableKeys = Object.keys(formData).filter(key => !formData[key].readonly);
  const grouped = new Set();
  const groups = [];
  for (const group of CONFIG_FIELD_GROUPS) {
    const keys = group.keys.filter(key => editableKeys.includes(key));
    keys.forEach(key => grouped.add(key));
    if (keys.length) groups.push({ label: group.label, blurb: group.blurb, fields: keys.map(key => ({ key, ...formData[key] })) });
  }
  const leftovers = editableKeys.filter(key => !grouped.has(key));
  if (leftovers.length) groups.push({ label: 'Other', blurb: 'New settings that have not been given a home yet.', fields: leftovers.map(key => ({ key, ...formData[key] })) });
  return groups;
}

// THE SELF APP'S SECTION PAYLOADS - THE BOT'S OWN STATE INSTEAD OF A SERVICE
async function buildSelfSectionData(core, instance, section, opts = {}) {
  const data = { configured: true, appUrl: null };
  switch (section) {
    case 'users': {
      // A DEEP LINK (PROFILE MODAL'S FOOTER) PRE-FILLS THE SEARCH WITH THE
      // USER'S ID - FILTER 'all' SO BOTS AND EDGE ROWS ARE ALWAYS FINDABLE
      data.users = await buildUsersPage(core, opts.userSearch || '', 1, opts.userSearch ? 'all' : 'people');
      data.mutableFields = USER_MUTABLE_FIELDS;
      break;
    }
    // THE UNIFIED REQUEST PIPELINE - EVERY MediaRequest TRACED REQUEST ->
    // INDEXER -> DOWNLOAD -> MEDIA SERVER (VIEW MODEL IN requestViews.js)
    case 'requests': {
      // A DEEP LINK (CHAT CARD / PROFILE ROW) PRE-FILLS THE SEARCH WITH THE
      // REQUEST'S TITLE SO THE LINKED CARD IS THE FIRST THING ON SCREEN
      let search = '';
      if (opts.requestId) {
        const linked = await core.models.mediaRequest.findFirst({ id: opts.requestId }, { media: true });
        search = linked?.media?.title || linked?.orig_parsed_title || '';
      }
      data.requests = await core.apps.getRequestsPage({ search });
      data.instanceOptions = await core.apps.buildInstanceOptions();
      break;
    }
    // THE UNIFIED LIBRARY - EVERY SERVICE'S LISTING MERGED BY EXTERNAL ID/PATH
    case 'library': {
      data.unified = await core.apps.getUnifiedPage({});
      data.view = core.apps.getBrowseView(instance.id, 'library');
      break;
    }
    case 'logs': {
      data.logs = await buildLogsPage(core);
      data.logLevels = LOG_LEVELS;
      break;
    }
    case 'settings': {
      data.formGroups = buildConfigGroups(await core.models.configuration.getPages());
      break;
    }
    // THE DISCORD BOT TAB - FEATURE MATRIX + THE MOVED IDENTITY/AUDIENCE FIELDS
    case 'bot': {
      data.bot = await buildBotMatrix(core);
      break;
    }
    default: {
      const [state, discordBot, config, serverCount, userCount, requestCount, pendingCount, installed] = await Promise.all([
        core.models.state.get(),
        core.models.discordBot.get(),
        core.models.configuration.get(),
        core.prisma.discordServer.count(),
        core.prisma.user.count(),
        core.prisma.mediaRequest.count(),
        core.prisma.mediaRequest.count({ where: { status: null } }),
        core.models.app.getInstalled()
      ]);
      const botOnline = !!(core.client && core.client.isReady());

      data.bot = {
        username: discordBot.bot_username,
        discriminator: discordBot.bot_discriminator,
        avatar: rootRelative(discordBot.bot_avatar_url),
        inviteLink: discordBot.bot_invite_link,
        online: botOnline,
        enabled: state.discord_state,
        version: DISCOFLIX_VERSION
      };

      data.problems = [];
      if (!config.discord_token) {
        data.problems.push({ type: 'error', message: 'No Discord bot token is set - add one in Settings to bring the bot online' });
      } else if (state.discord_state && !botOnline) {
        data.problems.push({ type: 'error', message: 'The bot is powered on but not connected to Discord' });
      } else if (!state.discord_state) {
        data.problems.push({ type: 'warning', message: 'The bot is powered off - requests from Discord are paused' });
      }
      if (!config.admin_password) {
        data.problems.push({ type: 'warning', message: 'The console has no admin password - anyone who can reach it has full control' });
      }
      if (botOnline && serverCount === 0) {
        data.problems.push({ type: 'warning', message: 'The bot is not in any Discord server yet - use the invite link to add it' });
      }

      data.apps = installed
        .filter(row => !core.apps.getType(row.app_type)?.hidden)
        .map(row => {
          const manifest = core.apps.getType(row.app_type) || {};
          const status = core.apps.statusCache.get(row.id);
          let statusText = 'Waiting for first check';
          let statusClass = 'pending';
          if (!core.apps.isConfigured(row)) {
            statusText = 'Not configured';
            statusClass = 'pending';
          } else if (!row.enabled) {
            statusText = 'Disabled';
            statusClass = 'down';
          } else if (status) {
            statusText = status.ok ? (status.version ? `Online - v${status.version}` : 'Online') : 'Unreachable';
            statusClass = status.ok ? 'ok' : 'down';
          }
          if (statusClass === 'down') {
            data.problems.push({
              type: row.enabled ? 'error' : 'warning',
              message: row.enabled ? `${row.display_name} is unreachable` : `${row.display_name} is disabled`
            });
          }
          return { id: row.id, label: row.display_name, icon: manifest.icon, statusText, statusClass };
        });

      data.stats = {
        servers: serverCount,
        users: userCount,
        requests: requestCount,
        pending: pendingCount,
        queueCount: core.apps.buildTickerAggregate()?.count || 0
      };
      break;
    }
  }
  return data;
}

// PER-SECTION PAYLOAD. RENDERS NEVER BLOCK ON LIVE HTTP EXCEPT: OVERVIEW'S
// HEALTH LIST (ONE GUARDED CALL), A FIRST-EVER STATUS CHECK WHEN THE
// HEARTBEAT HASN'T RUN YET, AND THE LIBRARY SECTION'S LIVE SEARCH MODE.
async function buildSectionData(core, instance, section, opts = {}) {
  if (instance.app_type === 'discoflix') return buildSelfSectionData(core, instance, section, opts);
  const client = core.apps.getClientForInstance(instance);
  const configured = !!client;
  const data = { configured, appUrl: configured ? client.baseUrl : null };

  switch (section) {
    // THE ABOUT-THIS-APP PAGE - VIEW MODEL LIVES IN appOverview.js
    case 'overview': {
      return buildOverviewData(core, instance);
    }
    case 'queue': {
      data.queue = core.apps.queueCache.get(instance.id) || [];
      data.queueActions = core.apps.queueActionsFor(instance);
      data.canAddByUrl = !!(client && client.capabilities.addByUrl);
      break;
    }
    // NOW PLAYING - LIVE STREAMS OFF THE MEDIA SERVER, HEARTBEAT KEEPS THE
    // OPEN SECTION MOVING VIA sessionsBody PUSHES
    case 'sessions': {
      const { sessions, error } = configured
        ? await core.apps.getSessionsFor(instance)
        : { sessions: [], error: null };
      data.sessions = sessions;
      data.sessionsError = error;
      break;
    }
    // RELEASES - THE INDEXER'S SEARCH SURFACE. A TERM RUNS THE META SEARCH,
    // IDLE SHOWS THE INDEXER ROSTER (WHERE THE SERVICE EXPOSES ONE) AND A HINT
    case 'releases': {
      const term = String(opts.searchTerm || '').trim();
      data.mode = term ? 'search' : 'idle';
      data.searchTerm = term;
      if (term && configured) {
        const [{ releases, error }, grabTargets] = await Promise.all([
          core.apps.getReleaseResults(instance, term),
          core.apps.getGrabTargets()
        ]);
        data.releases = releases;
        data.releasesError = error;
        data.grabTargets = grabTargets;
      } else {
        data.releases = [];
        data.releasesError = null;
        data.grabTargets = { torrent: [], usenet: [] };
        if (configured) {
          try {
            data.indexers = await client.getIndexers();
          } catch (err) {
            core.logger.debug(`${instance.display_name} indexer roster failed: ${err.message}`);
            data.indexers = null;
          }
        }
      }
      break;
    }
    // ONE SURFACE, TWO SOURCES: THE UNIFIED LIBRARY SCOPED TO THIS INSTANCE
    // (BROWSE) OR LIVE SEARCH RESULTS WHEN THE RAIL SEARCH BAR CARRIES A TERM
    case 'library': {
      const manifest = core.apps.getType(instance.app_type);
      data.contentTypeLabel = manifest.contentTypes[0]?.label || manifest.browseLabel || 'item';
      data.contentKind = manifest.contentTypes[0]?.type || 'movie';
      data.searchable = !!(client && client.capabilities.search);
      const term = String(opts.searchTerm || '').trim();
      data.mode = term ? 'search' : 'library';
      data.view = core.apps.getBrowseView(instance.id, data.mode);
      data.searchTerm = term;
      data.instanceTabs = [];
      if (term) {
        const { results, error } = await core.apps.getSearchResults(instance, term);
        data.searchResults = results;
        data.searchError = error;
        // "ADD TO" TABS WHEN RIVAL INSTANCES SERVE THE SAME CONTENT TYPE - A
        // TAB RE-RUNS THE SEARCH INSIDE THE RIVAL'S TAKEOVER (TERM RIDES ALONG)
        const contentType = manifest.contentTypes[0]?.type;
        if (contentType) {
          const peers = await core.apps.instancesForContentType(contentType);
          if (peers.length > 1) {
            data.instanceTabs = peers.map(peer => ({
              id: peer.id,
              label: peer.display_name,
              active: peer.id === instance.id
            }));
          }
        }
      } else {
        // THE SAME GLOBAL COMPONENT EVERY TAKEOVER RENDERS - JUST FILTERED
        data.unified = await core.apps.getUnifiedPage({ scopeAppId: instance.id });
      }
      break;
    }
    case 'settings': {
      const manifest = core.apps.getType(instance.app_type);
      // METADATA DESCRIPTORS (SENSITIVE isSet, TYPES) OVERLAID WITH THE
      // MANIFEST'S PER-TYPE LABELS/PLACEHOLDERS - ONE SHAPE FOR THE +field MIXIN
      const formData = core.models.app.getFormData(instance);
      data.formFields = [
        { key: 'display_name', ...formData.display_name },
        { key: 'enabled', ...formData.enabled },
        ...manifest.configFields.map(field => ({
          key: field.key,
          ...formData[field.key],
          label: field.label,
          description: field.description || formData[field.key].description,
          required: field.required,
          placeholder: field.placeholder
        }))
      ];
      // PER-INSTANCE ADD DEFAULTS (ROOT FOLDER / QUALITY PROFILE) - OPTIONS
      // FETCHED LIVE FROM THE SERVICE, VALUES OFF settings_json, BLANK = FIRST
      data.optionFields = [];
      data.optionsError = null;
      if (manifest.instanceOptions?.length && client) {
        let saved = {};
        try { saved = JSON.parse(instance.settings_json || '{}'); } catch (err) { saved = {}; }
        try {
          const fetched = {
            rootFolders: (await client.getRootFolders()).map(folder => ({ value: folder.path, label: folder.path })),
            qualityProfiles: (await client.getQualityProfiles()).map(profile => ({ value: String(profile.id), label: profile.name })),
            // LIDARR-ONLY THIRD SELECT - ONLY FETCHED WHERE THE CLIENT HAS IT
            ...(typeof client.getMetadataProfiles === 'function' ? {
              metadataProfiles: (await client.getMetadataProfiles()).map(profile => ({ value: String(profile.id), label: profile.name }))
            } : {})
          };
          data.optionFields = manifest.instanceOptions.map(option => ({
            key: option.key,
            type: 'string',
            label: option.label,
            description: option.description,
            value: saved[option.key] || '',
            options: [{ value: '', label: 'First available (default)' }, ...(fetched[option.fetch] || [])]
          }));
        } catch (err) {
          core.logger.debug(`${instance.display_name} option fetch failed: ${err.message}`);
          data.optionsError = `${instance.display_name} is unreachable - add defaults appear once it connects`;
        }
      }
      // MAKE-DEFAULT ONLY MEANS SOMETHING FOR CONTENT MANAGERS WITH RIVALS
      data.showDefault = false;
      if (manifest.contentTypes.length) {
        const peerCount = await core.prisma.app.count({
          where: { app_type: { in: core.apps.peerAppTypes(instance.app_type) } }
        });
        data.showDefault = peerCount > 1;
      }
      data.contentTypeLabels = manifest.contentTypes.map(ct => ct.label);
      break;
    }
    default:
      break;
  }
  return data;
}

// SECTION-NAV LOCALS - SIDEBAR TOGGLES USE THIS
function buildSectionNav(core, instance) {
  const manifest = core.apps.getType(instance.app_type);
  const section = manifest.sections.includes(instance.active_section)
    ? instance.active_section
    : 'overview';
  return {
    activeApp: instance,
    appManifest: manifest,
    appSections: manifest.sections.map(key => ({
      key,
      label: core.apps.SECTION_LABELS[key] || key
    })),
    section,
    sectionLabel: core.apps.SECTION_LABELS[section] || section
  };
}

async function buildTakeoverLocals(core, instance, opts = {}) {
  const nav = buildSectionNav(core, instance);
  const [sectionData, feed] = await Promise.all([
    buildSectionData(core, instance, nav.section, opts),
    // THE ACTIVITY FEED RAIL RIDES ALONG IN EVERY SECTION (CACHED PAGE 1)
    core.apps.getFeedViewModel(instance)
  ]);
  // THE RAIL SEARCH BAR RIDES EVERY SECTION OF A SEARCH-CAPABLE APP - TYPING
  // ANYWHERE DROPS THE SURFACE INTO ITS SEARCH SECTION (LIBRARY OR RELEASES)
  const client = core.apps.getClientForInstance(instance);
  const railSearch = client && client.capabilities.search ? {
    term: String(opts.searchTerm || '').trim(),
    placeholder: `Search ${nav.appManifest.contentTypes[0]?.label || nav.appManifest.browseLabel || 'media'}s...`
  } : null;
  return {
    ...nav,
    sectionData,
    feed,
    railSearch,
    // queueBody.pug READS `queue`/`queueActions` DIRECTLY SO WS PUSHES AND HTTP RENDERS SHARE ONE SHAPE
    queue: sectionData.queue || [],
    queueActions: sectionData.queueActions || { item: [], queue: [] }
  };
}

// THE FULL TAKEOVER FRAGMENT SET - THE APP-SIDE ANALOG OF changeActiveServers
async function respondWithTakeover(ctx, instance, state, opts = {}) {
  const core = ctx.core;
  const [servers, discordBot, apps, takeover] = await Promise.all([
    core.render.getServerTemplateObj(null, state),
    core.models.discordBot.get(),
    core.apps.getRailViewModel(state),
    buildTakeoverLocals(core, instance, opts)
  ]);

  return ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug',
    'sidebar/servers/appRail.pug',
    'sidebar/servers/serverHomeButton.pug',
    'sidebar/servers/serverBannerContainer.pug',
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'chat/chatBar.pug',
    'chat/jumpToPresentBar.pug',
    'members/membersLayout.pug',
    'chat/downloadTicker.pug'
  ], {
    servers,
    discordBot,
    state,
    apps,
    members: [],
    ticker: core.apps.buildTickerAggregate(),
    ...takeover
  });
}

// MIRROR RESTORE - THE SAME FRAGMENT SET changeActiveServers SENDS, MINUS THE
// SERVER SWITCH. THE RESPONSE TO REMOVING THE ACTIVE APP: ITS TAKEOVER ENDS
// BY DEFINITION, SO THE CONSOLE FALLS BACK TO WHATEVER GUILD WAS ACTIVE.
// opts.anchorTarget = { channel_id, message_id }: TIME-TRAVEL RENDER - THE
// WINDOW AROUND THE TARGET WITH SENTINELS BOTH WAYS, NO UNREAD BOOKKEEPING
// (THE VIEW ISN'T AT THE LIVE HEAD, updateMessages MUST NOT RUN).
async function respondWithMirror(ctx, state, opts = {}) {
  const core = ctx.core;

  let around = null;
  if (opts.anchorTarget) {
    around = await core.models.discordChannel.getMessagesAround(
      opts.anchorTarget.channel_id,
      opts.anchorTarget.message_id
    );
    // ROWS DELETED BETWEEN CHECK AND FETCH - FALL BACK TO THE LIVE MIRROR
    if (!around && state.id) {
      await core.models.viewSession.clearAnchor(state.id);
      state.chat_anchor = null;
    }
  }

  const [msgObjects, servers, discordBot, members, apps] = await Promise.all([
    around ? Promise.resolve(around.messages) : core.discord.updateMessages(null, state),
    core.render.getServerTemplateObj(null, state),
    core.models.discordBot.get(),
    core.render.getServerMembers(state.active_server_id),
    core.apps.getRailViewModel(state)
  ]);

  const history = around
    ? (around.hasOlder
      ? { channelId: opts.anchorTarget.channel_id, beforeId: msgObjects[0].message_id }
      : null)
    : core.discord.historyCursorOf(msgObjects);
  const future = around && around.hasNewer
    ? { channelId: opts.anchorTarget.channel_id, afterId: msgObjects[msgObjects.length - 1].message_id }
    : null;
  const messages = await core.discord.compileMessages(msgObjects);
  const eomStamp = _.get(_.last(msgObjects), 'created_at');

  return ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug',
    'sidebar/servers/appRail.pug',
    'sidebar/servers/serverHomeButton.pug',
    'sidebar/servers/serverBannerContainer.pug',
    'sidebar/channels/channelsLayout.pug',
    'chat/messageChannelHeader.pug',
    'chat/chatBar.pug',
    'chat/messageContainer.pug',
    'chat/jumpToPresentBar.pug',
    'members/membersLayout.pug'
  ], { servers, discordBot, messages, eomStamp, state, members, apps, history, future, anchored: !!around });
}

// ── HANDLERS ─────────────────────────────────────────────────────────────

async function changeActiveApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const state = await ctx.updateView({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

// THE DISCORD BADGE'S ENTRY POINT - DISCOFLIX'S OWN TAKEOVER, ROW CREATED ON
// FIRST USE. LANDS ON THE LAST VIEWED SECTION LIKE ANY OTHER APP.
async function openDiscoFlix(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getSelfInstance();
  const state = await ctx.updateView({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

// THE BADGE'S HOVER COG JUMPS STRAIGHT TO A SECTION
async function openDiscoFlixSection(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getSelfInstance();
  const manifest = core.apps.getType('discoflix');
  const section = manifest.sections.includes(ctx.params.section)
    ? ctx.params.section
    : 'overview';
  await core.models.app.update({ id: instance.id }, { active_section: section });
  instance.active_section = section;
  const state = await ctx.updateView({ active_app_id: instance.id });
  // ?user= DEEP-LINKS THE USERS SECTION TO ONE CARD (PROFILE MODAL FOOTER);
  // ?request= DOES THE SAME FOR THE REQUESTS SECTION (CHAT CARD/PROFILE ROW)
  return respondWithTakeover(ctx, instance, state, {
    userSearch: String(ctx.query.user || '').trim(),
    requestId: String(ctx.query.request || '').trim()
  });
}

// USERS SECTION SEARCH + FILTER TABS - SWAPS THE WHOLE BODY SO TABS, COUNTS,
// AND CARDS ALWAYS AGREE (SAME PATTERN AS THE UNIFIED LIBRARY)
async function appUsersBody(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return;
  }
  const search = String(ctx.query.search || '').trim();
  const filter = String(ctx.query.filter || '').trim();
  const users = await buildUsersPage(core, search, 1, filter);
  return ctx.compileView('apps/sections/dfUsersBody.pug', {
    activeApp: instance,
    users,
    mutableFields: USER_MUTABLE_FIELDS
  });
}

// USERS PAGINATION - THE VIEW MORE SENTINEL SWAPS ITSELF FOR BARE CARDS
async function appUsersPage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return;
  }
  const page = Math.max(1, parseInt(ctx.params.page, 10) || 1);
  const search = String(ctx.query.search || '').trim();
  const filter = String(ctx.query.filter || '').trim();
  const users = await buildUsersPage(core, search, page, filter);
  return ctx.compileView('apps/sections/dfUserCards.pug', {
    activeApp: instance,
    users,
    mutableFields: USER_MUTABLE_FIELDS
  });
}

// LOGS SECTION FILTER + PAGINATION - RETURNS BARE ROWS (AND THE NEXT VIEW
// MORE SENTINEL) FOR #dfLogList, PLUS AN OOB COUNT SWAP FOR THE TOOLBAR
async function appLogsPage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return;
  }
  const page = Math.max(1, parseInt(ctx.query.page, 10) || 1);
  const level = String(ctx.query.level || '').trim();
  const search = String(ctx.query.search || '').trim();
  const logs = await buildLogsPage(core, level, page, search);
  return ctx.compileView('apps/sections/dfLogRows.pug', { activeApp: instance, logs, oob: true });
}

// USER CARD SAVE - WHITELISTED MUTABLE SUBSET ONLY; DISCORD-SYNCED IDENTITY
// FIELDS ARE readonly IN METADATA SO safeUpdateOne NEVER TOUCHES THEM
async function saveAppUser(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return;
  }
  const user = await core.models.user.get({ id: ctx.params.userId });
  if (!user) {
    ctx.status = 404;
    return;
  }

  const data = {};
  for (const key of USER_MUTABLE_FIELDS) {
    if (key in (ctx.request.body || {})) data[key] = ctx.request.body[key];
  }

  let fresh;
  try {
    fresh = await core.models.user.safeUpdateOne(user.id, data);
    // A CONSOLE GRANT SETTLES A PENDING ACCESS ASK
    if (fresh.access_requested_at && (fresh.is_whitelisted || fresh.is_superuser || fresh.is_staff)) {
      fresh = await core.models.user.update({ id: fresh.id }, { access_requested_at: null });
    }
  } catch (err) {
    core.logger.error('USER SAVE FAILED:', err);
    ctx.status = 400;
    ctx.body = { error: err.message };
    return;
  }

  return ctx.compileView(['apps/sections/dfUserCard.pug', 'extra/notification.pug'], {
    activeApp: instance,
    user: {
      row: {
        ...fresh,
        avatar_url: rootRelative(fresh.avatar_url),
        lastSeenLabel: lastSeenLabel(fresh.last_seen_at),
        wantsAccess: !!fresh.access_requested_at
          && !fresh.is_whitelisted && !fresh.is_superuser && !fresh.is_staff
      },
      fields: core.models.user.getFormData(fresh)
    },
    mutableFields: USER_MUTABLE_FIELDS,
    message: `Saved ${fresh.display_name || fresh.username}`
  });
}

// SECTION NAV. WHEN THE TARGET INSTANCE ISN'T THE ACTIVE APP THIS ALSO ENTERS
// ITS TAKEOVER - ONE ROUTE POWERS SECTION ROWS, SEARCH INSTANCE TABS, AND THE
// DOWNLOAD TICKER'S JUMP-TO-QUEUE.
async function changeAppSection(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }

  const manifest = core.apps.getType(instance.app_type);
  const section = manifest.sections.includes(ctx.params.section)
    ? ctx.params.section
    : 'overview';
  await core.models.app.update({ id: instance.id }, { active_section: section });
  instance.active_section = section;

  let state = ctx.viewState;
  if (state.active_app_id !== instance.id) {
    state = await ctx.updateView({ active_app_id: instance.id });
    return respondWithTakeover(ctx, instance, state);
  }

  const takeover = await buildTakeoverLocals(core, instance);
  return ctx.compileView([
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug'
  ], { state, ...takeover });
}

// ACTIVITY-FEED PAGINATION - THE REVEALED SENTINEL IN THE RIGHT RAIL SWAPS
// ITSELF FOR THE NEXT PAGE OF ROWS (+ A NEW SENTINEL WHILE THERE'S MORE)
async function appFeedPage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const page = Math.max(1, parseInt(ctx.params.page, 10) || 1);
  const feed = await core.apps.getFeedPage(instance, page);
  return ctx.compileView('apps/appFeedItems.pug', { activeApp: instance, feed, feedPage: page });
}

// THE HUB (SELF APP) BROWSES EVERYTHING; ANY OTHER TAKEOVER IS THE SAME
// COMPONENT SCOPED TO THAT INSTANCE'S HOLDINGS
function unifiedScopeOf(instance) {
  return instance.app_type === 'discoflix' ? null : instance.id;
}

// UNIFIED LIBRARY FILTERS - TERM/KIND/VIEW CHANGES SWAP THE WHOLE BODY SO
// THE TABS, COUNTS, AND GRID ALWAYS AGREE
async function appUnifiedLibrary(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const view = String(ctx.query.view || '').trim();
  if (view) core.apps.setBrowseView(instance.id, 'library', view);
  const unified = await core.apps.getUnifiedPage({
    kind: String(ctx.query.kind || 'all').trim(),
    term: String(ctx.query.term || '').trim(),
    scopeAppId: unifiedScopeOf(instance)
  });
  return ctx.compileView('apps/sections/dfLibraryBody.pug', {
    activeApp: instance,
    unified,
    view: core.apps.getBrowseView(instance.id, 'library')
  });
}

// UNIFIED LIBRARY PAGINATION - THE VIEW MORE SENTINEL SWAPS ITSELF FOR THE
// NEXT PAGE OF CARDS (FILTERS RIDE THE QUERY STRING)
async function appUnifiedLibraryPage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const unified = await core.apps.getUnifiedPage({
    page: Math.max(1, parseInt(ctx.params.page, 10) || 1),
    kind: String(ctx.query.kind || 'all').trim(),
    term: String(ctx.query.term || '').trim(),
    scopeAppId: unifiedScopeOf(instance)
  });
  return ctx.compileView('apps/unifiedCards.pug', {
    activeApp: instance,
    unified,
    view: core.apps.getBrowseView(instance.id, 'library')
  });
}

// ORIGIN - THE MEDIA<->REQUEST LEDGER JOIN FOR A DETAIL RENDER. BEST-EFFORT:
// A FAILED LOOKUP NEVER BLOCKS OR FAILS THE DETAIL, IT JUST RENDERS NO BLOCK.
// EPHEMERAL (PRE-ADD) LOOKUPS HAVE NO LIBRARY ITEM TO TRACE.
async function withOrigin(core, locals) {
  if (locals.detail && !locals.ephemeral) {
    try {
      locals.origin = await core.apps.getRequestOrigin(locals.detail);
    } catch (err) {
      core.logger.debug(`Origin lookup skipped: ${err.message}`);
    }
  }
  return locals;
}

// LIBRARY ITEM DETAIL - CLICKING A POSTER SWAPS THE SECTION BODY FOR THE
// IN-CONSOLE EQUIVALENT OF THE ARR'S OWN DETAIL PAGE (NO LINK-OUTS, EVER).
// from=search KEEPS THE BACK BUTTON POINTED AT THE SEARCH RESULTS.
async function appLibraryItem(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const { detail, error } = await core.apps.getLibraryItemDetail(instance, ctx.params.itemId);
  return ctx.compileView('apps/sections/libraryDetail.pug', await withOrigin(core, {
    activeApp: instance,
    detail: detail || null,
    detailError: error || null,
    backTo: ['search', 'hub', 'requests'].includes(ctx.query.from) ? ctx.query.from : 'library'
  }));
}

// EPHEMERAL SEARCH-RESULT DETAIL - THE LIBRARY DETAIL VIEW BUILT FROM A LIVE
// LOOKUP BEFORE THE ITEM EXISTS IN THE SERVICE; ADDING IT UNLOCKS THE REAL ONE
async function appLookupDetail(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const client = core.apps.getClientForInstance(instance);
  const locals = { activeApp: instance, detail: null, detailError: null, ephemeral: true, backTo: 'search' };
  try {
    if (!client || !client.capabilities.libraryDetail) {
      throw new Error(`${instance.display_name} has no detail view`);
    }
    const result = await client.lookupByExternalId(ctx.params.externalKey);
    if (!result) throw new Error('Lookup came back empty - try the search again');
    if (result.libraryId) {
      // THE SERVICE GAINED THE ITEM SINCE THE RESULTS RENDERED - SHOW THE REAL THING
      const { detail, error } = await core.apps.getLibraryItemDetail(instance, result.libraryId);
      locals.detail = detail || null;
      locals.detailError = error || null;
      locals.ephemeral = false;
    } else {
      locals.detail = { ...client.normalizeLookupDetail(result.raw), externalKey: result.externalKey };
    }
  } catch (err) {
    core.logger.warn(`${instance.display_name} lookup detail failed: ${err.message}`);
    locals.detailError = err.message;
  }
  return ctx.compileView('apps/sections/libraryDetail.pug', await withOrigin(core, locals));
}

// DETAIL-VIEW VERBS (MONITOR TOGGLE / SEARCH) - MUTATE, RE-PULL, RE-RENDER THE
// DETAIL BODY SO THE VIEW ALWAYS SHOWS WHAT THE ARR NOW BELIEVES
async function appLibraryItemAction(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const client = core.apps.getClientForInstance(instance);
  const itemId = ctx.params.itemId;
  const verb = ctx.params.verb;
  let message;
  try {
    if (!client || !client.capabilities.libraryDetail) throw new Error(`${instance.display_name} has no detail actions`);
    if (verb === 'monitor') {
      const monitored = String(ctx.request.body?.monitored) === 'true';
      await client.setMonitored(itemId, monitored);
      message = monitored ? 'Monitoring turned on' : 'Monitoring turned off';
    } else if (verb === 'search') {
      await client.triggerItemSearch(itemId);
      message = `${instance.display_name} is searching`;
    } else {
      throw new Error(`Unknown detail action '${verb}'`);
    }
    core.apps.libraryCache.delete(instance.id); // MONITOR FLAGS RIDE THE LISTING
  } catch (err) {
    core.logger.warn(`Detail action '${verb}' failed on ${instance.display_name}: ${err.message}`);
    message = err.message;
  }

  const { detail, error } = await core.apps.getLibraryItemDetail(instance, itemId);
  return ctx.compileView(['apps/sections/libraryDetail.pug', 'extra/notification.pug'], await withOrigin(core, {
    activeApp: instance,
    detail: detail || null,
    detailError: error || null,
    backTo: ['search', 'hub', 'requests'].includes(ctx.request.body?.from) ? ctx.request.body.from : 'library',
    message
  }));
}

// ONE SEASON'S EPISODE TABLE - LAZY-LOADED WHEN A DETAIL SEASON ROW EXPANDS
async function appSeasonEpisodes(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const client = instance && core.apps.getClientForInstance(instance);
  if (!client || typeof client.getSeasonEpisodes !== 'function') {
    ctx.status = 404;
    return;
  }
  const locals = {
    activeApp: instance,
    itemId: ctx.params.itemId,
    season: parseInt(ctx.params.season, 10),
    from: ['search', 'hub', 'requests'].includes(ctx.query.from) ? ctx.query.from : 'library',
    episodes: [],
    episodesError: null
  };
  try {
    locals.episodes = await client.getSeasonEpisodes(ctx.params.itemId, locals.season);
  } catch (err) {
    core.logger.warn(`${instance.display_name} episode fetch failed: ${err.message}`);
    locals.episodesError = err.message;
  }
  return ctx.compileView('apps/sections/seasonEpisodes.pug', locals);
}

// INTERACTIVE SEARCH - THE ARR SWEEPS ITS INDEXERS AND THE OPERATOR PICKS THE
// RELEASE. SCOPE COMES FROM THE QUERY (WHOLE MOVIE / SEASON / EPISODE); THE
// CALLER-PROVIDED label KEEPS THE HEADING HONEST WITHOUT A SECOND DETAIL PULL.
async function appItemReleases(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const client = instance && core.apps.getClientForInstance(instance);
  if (!client || !client.capabilities.interactiveSearch) {
    ctx.status = 404;
    return;
  }
  const locals = {
    activeApp: instance,
    itemId: ctx.params.itemId,
    label: String(ctx.query.label || '').slice(0, 120),
    from: ['search', 'hub', 'requests'].includes(ctx.query.from) ? ctx.query.from : 'library',
    releases: [],
    releasesError: null
  };
  try {
    locals.releases = await client.getInteractiveReleases({
      arrId: ctx.params.itemId,
      season: ctx.query.season != null && ctx.query.season !== '' ? Number(ctx.query.season) : null,
      episodeId: ctx.query.episode || null
    });
  } catch (err) {
    core.logger.warn(`${instance.display_name} interactive search failed: ${err.message}`);
    locals.releasesError = err.message;
  }
  return ctx.compileView('apps/sections/libraryReleases.pug', locals);
}

// GRAB A PICKED RELEASE - THE ARR ROUTES IT TO ITS OWN DOWNLOAD CLIENT. THE
// RESPONSE REBUILDS THE CLICKED ROW FROM THE POSTED DISPLAY FIELDS AND TOASTS.
async function appGrabItemRelease(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const client = instance && core.apps.getClientForInstance(instance);
  if (!client || !client.capabilities.interactiveSearch) {
    ctx.status = 404;
    return;
  }
  const body = ctx.request.body || {};
  const release = {
    guid: String(body.guid || ''),
    indexerId: body.indexerId ? Number(body.indexerId) : null,
    title: String(body.title || 'Unknown release'),
    indexer: body.indexer || null,
    quality: body.quality || null,
    protocol: body.protocol === 'usenet' ? 'usenet' : 'torrent',
    size: body.size ? Number(body.size) : null,
    sizeHuman: body.sizeHuman || null,
    seeders: body.seeders ? Number(body.seeders) : null,
    age: body.age || null,
    ageMinutes: body.ageMinutes ? Number(body.ageMinutes) : null,
    languages: body.languages || null,
    rejected: false,
    rejections: []
  };
  try {
    if (!release.guid || !release.indexerId) throw new Error('This release is missing its grab handle');
    await client.grabRelease(release.guid, release.indexerId);
    release.rowState = 'grabbed';
  } catch (err) {
    core.logger.warn(`Release grab failed on ${instance.display_name}: ${err.message}`);
    release.rowState = 'error';
    release.error = err.message;
  }
  return ctx.compileView(['apps/libraryReleaseRow.pug', 'extra/notification.pug'], {
    activeApp: instance,
    release,
    itemId: ctx.params.itemId,
    message: release.rowState === 'grabbed'
      ? `Grabbed - ${instance.display_name} is sending it to its download client`
      : release.error
  });
}

// MANAGE PANEL SAVE (QUALITY PROFILE / ROOT FOLDER) - MUTATE, RE-PULL,
// RE-RENDER SO THE VIEW SHOWS WHAT THE ARR NOW BELIEVES
async function appEditLibraryItem(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const client = instance && core.apps.getClientForInstance(instance);
  if (!client || !client.capabilities.libraryEdit) {
    ctx.status = 404;
    return;
  }
  const body = ctx.request.body || {};
  let message;
  try {
    await client.updateItemSettings(ctx.params.itemId, {
      qualityProfileId: body.qualityProfileId || null,
      rootFolderPath: body.rootFolderPath || null,
      moveFiles: String(body.moveFiles) === 'on' || String(body.moveFiles) === 'true'
    });
    message = 'Saved';
    core.apps.libraryCache.delete(instance.id);
  } catch (err) {
    core.logger.warn(`Library edit failed on ${instance.display_name}: ${err.message}`);
    message = err.message;
  }
  const { detail, error } = await core.apps.getLibraryItemDetail(instance, ctx.params.itemId);
  return ctx.compileView(['apps/sections/libraryDetail.pug', 'extra/notification.pug'], await withOrigin(core, {
    activeApp: instance,
    detail: detail || null,
    detailError: error || null,
    backTo: ['search', 'hub', 'requests'].includes(body.from) ? body.from : 'library',
    message
  }));
}

// DANGER CONFIRM FOR REMOVING A LIBRARY ITEM - FILE DELETION AND LIST
// EXCLUSION ARE EXPLICIT CHECKBOXES, NEVER DEFAULTS
async function confirmLibraryDelete(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const client = instance && core.apps.getClientForInstance(instance);
  if (!client || !client.capabilities.libraryDelete) {
    ctx.status = 404;
    return;
  }
  return ctx.compileView('modals/apps/libraryDelete.pug', {
    app: instance,
    itemId: ctx.params.itemId,
    itemTitle: String(ctx.query.title || 'this item').slice(0, 120)
  });
}

// DROP THE ITEM AND RESTORE WHATEVER TAKEOVER SURFACE THE OPERATOR IS ON -
// THE ARR LIBRARY OR THE UNIFIED HUB BOTH RE-RENDER WITHOUT THE ITEM
async function appDeleteLibraryItem(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const client = instance && core.apps.getClientForInstance(instance);
  if (!client || !client.capabilities.libraryDelete) {
    ctx.status = 404;
    return;
  }
  const body = ctx.request.body || {};
  let message;
  try {
    await client.deleteItem(ctx.params.itemId, {
      deleteFiles: String(body.deleteFiles) === 'on',
      addExclusion: String(body.addExclusion) === 'on'
    });
    message = `Removed from ${instance.display_name}`;
    core.apps.libraryCache.delete(instance.id);
    core.apps.feedCache.delete(instance.id);
  } catch (err) {
    core.logger.warn(`Library delete failed on ${instance.display_name}: ${err.message}`);
    message = err.message;
  }

  const state = ctx.viewState;
  const current = state.active_app_id ? await core.apps.getInstance(state.active_app_id) : null;
  if (!current) return respondWithMirror(ctx, state);
  const takeover = await buildTakeoverLocals(core, current);
  return ctx.compileView([
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'extra/notification.pug'
  ], { state, message, ...takeover });
}

// THE RAIL SEARCH BAR'S ROUTE: A TERM DROPS THE TAKEOVER INTO THE APP'S
// SEARCH SECTION (LIBRARY FOR MEDIA APPS, RELEASES FOR INDEXERS - THE INPUT
// LIVES IN THE UNTOUCHED RIGHT RAIL, SO THE TRANSITION IS SEAMLESS); AN EMPTY
// TERM FALLS BACK TO BROWSING. CROSS-INSTANCE CALLS (ADD-TO TABS) ENTER THAT
// APP'S TAKEOVER, TERM RIDING ALONG. ?view= ALSO SERVES THE COVERS/DETAILED
// TOGGLE - SAME RENDER, NEW STYLE.
async function appSearch(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const manifest = instance && core.apps.getType(instance.app_type);
  const searchSection = manifest?.sections.includes('library')
    ? 'library'
    : (manifest?.sections.includes('releases') ? 'releases' : null);
  if (!instance || !searchSection) {
    ctx.status = 404;
    return;
  }

  const term = String(ctx.query.term || '').trim();
  const view = String(ctx.query.view || '').trim();
  if (view && searchSection === 'library') {
    core.apps.setBrowseView(instance.id, term ? 'search' : 'library', view);
  }

  let state = ctx.viewState;
  // CLEARING THE BOX ONLY MEANS SOMETHING ON THE SEARCH SURFACE - FROM ANY
  // OTHER SECTION AN EMPTY TERM MUST NOT YANK THE VIEW AROUND
  if (!term && !view && (state.active_app_id !== instance.id || instance.active_section !== searchSection)) {
    ctx.status = 204;
    return;
  }

  if (instance.active_section !== searchSection) {
    await core.models.app.update({ id: instance.id }, { active_section: searchSection });
    instance.active_section = searchSection;
  }

  if (state.active_app_id !== instance.id) {
    state = await ctx.updateView({ active_app_id: instance.id });
    return respondWithTakeover(ctx, instance, state, { searchTerm: term });
  }

  const takeover = await buildTakeoverLocals(core, instance, { searchTerm: term });
  return ctx.compileView([
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug'
  ], { state, ...takeover });
}

// OPERATOR ADD - THE ADMIN REQUEST PATH WITHOUT A GUILD: AUTO-APPROVED
// MediaRequest (NO madeIn/USERS), STRAIGHT client.add, NULL-CHANNEL WATCH.
// mode=detail ANSWERS THE EPHEMERAL DETAIL VIEW'S ADD WITH THE REAL DETAIL
// (ACTIONS UNLOCKED); OTHERWISE THE CLICKED RESULT ROW SWAPS IN PLACE.
async function appAddMedia(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const client = core.apps.getClientForInstance(instance);
  const externalKey = String(ctx.request.body?.externalKey || '').trim();
  const fromDetail = ctx.request.body?.mode === 'detail';
  if (!client || !client.capabilities.add || !externalKey) {
    ctx.status = 400;
    return;
  }

  let result = null;
  let added = null;
  let failure = null;
  try {
    result = await client.lookupByExternalId(externalKey);
    if (!result) throw new Error('Lookup came back empty - try the search again');

    // A libraryId MEANS SOMEONE BEAT US TO IT - REFLECT REALITY, NEVER DOUBLE-ADD
    if (!result.libraryId) {
      added = await client.add(result);
      const media = await core.models.media.upsertFromResult(result, added);
      const request = await core.models.mediaRequest.createRequest({
        mediaId: media.id,
        orig_parsed_title: result.title,
        orig_parsed_type: result.contentType,
        arr_id: String(added.id), // RESTARTS RE-ARM THE WATCH FROM THIS
        status: true, // CONSOLE = OPERATOR = PRE-APPROVED
        appId: instance.id
      });

      if (!core.apps.safeIsImported(client, added)) {
        core.apps.watchRequest({
          requestId: request.id,
          appId: instance.id,
          arrId: added.id,
          mediaId: media.id,
          title: result.year ? `${result.title} (${result.year})` : result.title,
          channelId: null, // CONSOLE-INITIATED - NO DISCORD NOTIFY
          requesterIds: [],
          featureId: result.contentType ? `request.${result.contentType}` : null,
          serverId: null
        });
      }

      core.apps.libraryCache.delete(instance.id); // THE LIBRARY GRID JUST GREW
      core.logger.info(`Console add: ${result.title} → ${instance.display_name}`);
    }
  } catch (err) {
    core.logger.error('Console add failed:', err);
    failure = err;
  }

  if (fromDetail) {
    const locals = { activeApp: instance, detail: null, detailError: null, ephemeral: false, backTo: 'search' };
    const libraryId = added?.id || result?.libraryId;
    if (libraryId) {
      const { detail, error } = await core.apps.getLibraryItemDetail(instance, libraryId);
      locals.detail = detail || null;
      locals.detailError = error || null;
      locals.message = failure
        ? failure.message
        : (added ? `Added ${result.title} - ${instance.display_name} is searching` : `Already in ${instance.display_name}`);
    } else if (result) {
      // ADD FAILED BUT THE LOOKUP HELD - STAY ON THE EPHEMERAL VIEW TO RETRY
      locals.ephemeral = true;
      locals.detail = { ...client.normalizeLookupDetail(result.raw), externalKey: result.externalKey };
      locals.message = failure ? failure.message : 'Add failed';
    } else {
      locals.detailError = failure ? failure.message : 'Add failed';
      locals.message = locals.detailError;
    }
    return ctx.compileView(['apps/sections/libraryDetail.pug', 'extra/notification.pug'], await withOrigin(core, locals));
  }

  let searchResult;
  if (failure) {
    searchResult = {
      ...(result || { title: ctx.request.body?.title || 'Unknown', contentType: null, posterUrl: null }),
      rowState: 'error',
      error: failure.message
    };
  } else if (added) {
    searchResult = { ...result, rowState: 'added' };
  } else {
    searchResult = { ...result, rowState: core.apps.rowStateOf(client, result) };
  }
  return ctx.compileView('apps/searchResultRow.pug', { activeApp: instance, searchResult });
}

// PROXIED SERVICE ART - THE CLIENT FETCHES WITH ITS OWN AUTH SERVER-SIDE, SO
// TOKENS NEVER RENDER INTO <img> TAGS AND LAN-ONLY SERVICES STILL SHOW ART.
// CLIENTS WHITELIST THEIR OWN IMAGE PATHS INSIDE fetchImage.
async function appImage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const client = instance && core.apps.getClientForInstance(instance);
  const path = String(ctx.query.path || '');
  if (!client || !path.startsWith('/') || path.includes('..')) {
    ctx.status = 404;
    return;
  }
  try {
    const image = await client.fetchImage(path);
    ctx.set('Content-Type', image.contentType);
    ctx.set('Cache-Control', 'private, max-age=3600');
    ctx.body = image.buffer;
  } catch (err) {
    core.logger.debug(`${instance.display_name} image proxy miss: ${err.message}`);
    ctx.status = 404;
  }
}

// PASTED MAGNET/TORRENT/NZB LINK INTO THE QUEUE - SAME RESPONSE SHAPE AS THE
// QUEUE VERBS SO THE LIST, TICKER, AND TOAST ALL MOVE TOGETHER
async function appQueueAdd(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }

  const url = String(ctx.request.body?.url || '').trim();
  const views = ['apps/sections/queueBody.pug', 'chat/downloadTicker.pug', 'extra/notification.pug'];
  const locals = { activeApp: instance, queueActions: core.apps.queueActionsFor(instance) };
  try {
    if (!/^(magnet:|https?:\/\/)/i.test(url)) throw new Error('Paste a magnet or http(s) link');
    locals.queue = await core.apps.addDownloadTo(instance, url);
    locals.message = 'Sent to the queue';
  } catch (err) {
    core.logger.warn(`Queue add failed on ${instance.display_name}: ${err.message}`);
    locals.queue = core.apps.queueCache.get(instance.id) || [];
    locals.message = err.message;
  }
  locals.ticker = core.apps.buildTickerAggregate();
  return ctx.compileView(views, locals);
}

// RELEASE GRAB - THE INDEXER ROW'S SEND-TO-CLIENT ACTION. RESPONSE SWAPS THE
// ROW (SENT/FAILED STATE REBUILT FROM THE POSTED FIELDS) AND TOASTS.
async function appGrabRelease(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }

  const body = ctx.request.body || {};
  const release = {
    id: String(body.releaseId || ''),
    title: String(body.title || 'Unknown'),
    indexer: body.indexer || null,
    category: body.category || null,
    protocol: body.protocol === 'usenet' ? 'usenet' : 'torrent',
    size: body.size ? Number(body.size) : null,
    sizeHuman: body.sizeHuman || null,
    seeders: body.seeders ? Number(body.seeders) : null,
    age: body.age || null,
    ageMinutes: body.ageMinutes ? Number(body.ageMinutes) : null,
    downloadUrl: String(body.url || '')
  };

  let target = null;
  try {
    target = await core.apps.getInstance(String(body.targetId || ''));
    if (!target || core.apps.getType(target.app_type)?.kind !== 'download-client') {
      throw new Error('Pick a download client to send this to');
    }
    if (!release.downloadUrl) throw new Error('This release carries no download link');
    await core.apps.addDownloadTo(target, release.downloadUrl);
    release.rowState = 'sent';
    release.sentTo = target.display_name;
  } catch (err) {
    core.logger.warn(`Release grab failed on ${instance.display_name}: ${err.message}`);
    release.rowState = 'error';
    release.error = err.message;
  }

  return ctx.compileView(['apps/releaseRow.pug', 'chat/downloadTicker.pug', 'extra/notification.pug'], {
    activeApp: instance,
    release,
    grabTargets: await core.apps.getGrabTargets(),
    ticker: core.apps.buildTickerAggregate(),
    message: release.rowState === 'sent'
      ? `Sent to ${release.sentTo} - watch its queue`
      : release.error
  });
}

// QUEUE VERBS FROM THE TAKEOVER UI - RESPONDS WITH OOB LIST + TICKER SO THE
// ROWS AND THE CHROME STRIP MOVE TOGETHER; FAILURES TOAST INTO THE APP HEADER
async function appQueueAction(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }

  const itemId = String(ctx.request.body?.itemId || '').trim() || null;
  const views = ['apps/sections/queueBody.pug', 'chat/downloadTicker.pug'];
  const locals = { activeApp: instance, queueActions: core.apps.queueActionsFor(instance) };
  try {
    locals.queue = await core.apps.performQueueAction(instance, ctx.params.verb, itemId);
  } catch (err) {
    core.logger.warn(`Queue action '${ctx.params.verb}' failed on ${instance.display_name}: ${err.message}`);
    locals.queue = core.apps.queueCache.get(instance.id) || [];
    locals.message = err.message;
    views.push('extra/notification.pug');
  }
  locals.ticker = core.apps.buildTickerAggregate();
  return ctx.compileView(views, locals);
}

// RAIL DRAG-SORT - THE APP-SIDE changeServerSortOrder. RESPONSE RE-RENDERS
// THE SELF-OOB RAIL SO THE DOM ORDER AND sort_position AGREE
async function changeAppSortOrder(ctx) {
  await ctx.core.models.app.reorder(ctx.request.body.item);
  const apps = await ctx.core.apps.getRailViewModel();
  return ctx.compileView(['sidebar/servers/appRail.pug'], { apps });
}

// ── ADD / SETTINGS / REMOVE FLOWS ────────────────────────────────────────

// "ADD AN APP" PICKER - ONE CARD PER MANIFEST TYPE; TYPES STAY ADDABLE
// FOREVER (MULTI-INSTANCE), THE BADGE JUST SAYS HOW MANY YOU ALREADY RUN
async function renderAppPicker(ctx) {
  const rows = await ctx.core.models.app.getInstalled();
  const counts = {};
  rows.forEach(row => { counts[row.app_type] = (counts[row.app_type] || 0) + 1; });

  const appTypes = ctx.core.apps.allTypes().filter(manifest => !manifest.hidden).map(manifest => ({
    id: manifest.id,
    label: manifest.label,
    icon: manifest.icon,
    blurb: manifest.blurb,
    kind: manifest.kind,
    why: manifest.why || null,
    functions: manifest.functions || [],
    installed: counts[manifest.id] || 0
  }));
  return ctx.compileView('modals/apps/picker.pug', { appTypes });
}

// PICKER CARD CLICK: CREATE THE ROW AND DROP STRAIGHT INTO ITS TAKEOVER ON
// SETTINGS - CONFIG-FIRST LANDING
async function addApp(ctx) {
  const core = ctx.core;
  const manifest = core.apps.getType(ctx.params.type);
  if (!manifest || manifest.hidden) {
    ctx.status = 404;
    return;
  }
  const instance = await core.apps.installType(ctx.params.type);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  core.apps.syncSlashCommands().catch(() => {});
  // OTHER CONNECTED VIEWS PICK THE NEW APP UP IN THEIR RAILS
  core.discord.refreshUI().catch(() => {});
  const state = await ctx.updateView({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

async function saveApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }

  let updated = instance;
  let message = 'Changes Saved';
  try {
    if (instance.app_type === 'discoflix') {
      // THE SELF APP'S SETTINGS FORM WRITES THE Configuration SINGLETON
      const config = await core.models.configuration.get();
      await core.models.configuration.safeUpdateOne(config.id, ctx.request.body);
      // PRESENCE SETTINGS TAKE EFFECT IMMEDIATELY WHILE THE BOT IS ONLINE
      if (core.client?.isReady()) core.discord.applyPresence().catch(() => {});
    } else {
      updated = await core.apps.saveInstanceConfig(instance, ctx.request.body);
      core.apps.syncSlashCommands().catch(() => {});
      // SAVE IS THE ONE MOMENT THE OPERATOR EXPECTS A LIVE ANSWER - REFRESH THE
      // STATUS CACHE NOW SO THE RAIL DOT AND TOAST TELL THE TRUTH IMMEDIATELY
      if (updated.enabled && core.apps.isConfigured(updated)) {
        const status = await core.apps.testInstance(updated);
        message = status.ok
          ? (status.version ? `Connected - v${status.version}` : 'Connected')
          : 'Saved - but unreachable';
      }
    }
  } catch (err) {
    core.logger.error('APP SAVE FAILED:', err);
    ctx.status = 400;
    ctx.body = { error: err.message };
    return;
  }

  // OTHER VIEWS' RAILS REFLECT THE SAVE (STATUS DOT, NAME) - THE ACTOR SITS
  // IN A TAKEOVER AND PICKS THE FRESH STATE UP ON BACK-OUT
  core.discord.refreshUI().catch(() => {});

  const state = ctx.viewState;
  const [apps, takeover] = await Promise.all([
    core.apps.getRailViewModel(state),
    buildTakeoverLocals(core, updated)
  ]);
  // NOTIFICATION LAST: THE SURFACE SWAP REPLACES #notification-container, SO
  // THE TOAST HAS TO LAND AFTER THE FRESH ONE EXISTS
  return ctx.compileView([
    'sidebar/servers/appRail.pug',
    'sidebar/servers/serverHomeButton.pug',
    'sidebar/servers/serverBannerLabel.pug',
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'extra/notification.pug'
  ], { state, apps, message, ...takeover });
}

// EXPLICIT LIVE CHECK AGAINST THE *SAVED* ROW - PROVES KEEP-ON-BLANK/CLEAR
// ACTUALLY PERSISTED WHAT YOU THINK. RESPONSE = INLINE PILL + RAIL DOT OOB
async function testApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type === 'discoflix') {
    ctx.status = 404;
    return;
  }
  const status = await core.apps.testInstance(instance);
  const apps = await core.apps.getRailViewModel();
  return ctx.compileView([
    'apps/sections/settingsTestResult.pug',
    'sidebar/servers/appRail.pug',
    'sidebar/servers/serverHomeButton.pug'
  ], { status, apps });
}

async function setDefaultApp(ctx) {
  const core = ctx.core;
  const target = await core.apps.getInstance(ctx.params.id);
  if (!target || target.app_type === 'discoflix') {
    ctx.status = 404;
    return;
  }
  let instance;
  try {
    instance = await core.apps.setDefaultInstance(ctx.params.id);
  } catch (err) {
    ctx.status = 404;
    return;
  }

  const state = ctx.viewState;
  const takeover = await buildTakeoverLocals(core, instance);
  return ctx.compileView([
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'extra/notification.pug'
  ], { state, message: `${instance.display_name} is now the default`, ...takeover });
}

async function confirmRemoveApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type === 'discoflix') {
    ctx.status = 404;
    return;
  }
  const manifest = core.apps.getType(instance.app_type);
  const requestCount = await core.prisma.mediaRequest.count({
    where: { appId: instance.id }
  });
  return ctx.compileView('modals/apps/confirmRemove.pug', {
    app: instance,
    typeLabel: manifest?.label || instance.app_type,
    requestCount
  });
}

async function removeApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type === 'discoflix') {
    ctx.status = 404;
    return;
  }
  await core.apps.removeInstance(instance.id);
  core.apps.syncSlashCommands().catch(() => {});

  // THE FK ALREADY SetNull'D EVERY SESSION INSIDE THIS TAKEOVER; THE EXPLICIT
  // UPDATE COVERS THE ACTING SESSION REMOVING A NON-ACTIVE APP THE SAME WAY.
  // OTHER SESSIONS' SURFACES SELF-HEAL ON THEIR NEXT NAVIGATION OR RELOAD.
  const state = await ctx.updateView({ active_app_id: null });
  return respondWithMirror(ctx, state);
}

module.exports = {
  buildAppRail,
  buildSectionNav,
  buildTakeoverLocals,
  respondWithMirror,
  rootRelative,
  lastSeenLabel,
  changeActiveApp,
  openDiscoFlix,
  openDiscoFlixSection,
  appUsersBody,
  appUsersPage,
  appLogsPage,
  saveAppUser,
  changeAppSection,
  appFeedPage,
  appUnifiedLibrary,
  appUnifiedLibraryPage,
  appLibraryItem,
  appLookupDetail,
  appLibraryItemAction,
  appSeasonEpisodes,
  appItemReleases,
  appGrabItemRelease,
  appEditLibraryItem,
  confirmLibraryDelete,
  appDeleteLibraryItem,
  appSearch,
  appAddMedia,
  appImage,
  appQueueAdd,
  appGrabRelease,
  appQueueAction,
  changeAppSortOrder,
  renderAppPicker,
  addApp,
  saveApp,
  testApp,
  setDefaultApp,
  confirmRemoveApp,
  removeApp
};
