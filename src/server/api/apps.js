// THE APP TAKEOVER SURFACE (nzb360-STYLE PSEUDO-GUILDS): CLICKING A RAIL
// BUBBLE SWAPS THE WHOLE CONSOLE TO THE APP'S SECTIONS (QUEUE/LIBRARY/...)
// USING THE SAME SLOT-SWAP FRAGMENTS THE SETTINGS SIDEBAR ALREADY PROVED.
const _ = require('lodash');

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
  'max_requests_in_day',
  'max_results',
  'max_seasons_for_non_admin',
  'session_timeout',
  'max_check_time'
];
const USERS_PAGE_SIZE = 20;

// CACHED IMAGES ARE STORED AS BARE RELATIVE PATHS - SERVE THEM ROOT-RELATIVE
function rootRelative(path) {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `/${String(path).replace(/^\/+/, '')}`;
}

// ONE USERS PAGE FOR THE SELF APP'S USERS SECTION - ROW + METADATA-DRIVEN
// FIELD DESCRIPTORS SO THE +field MIXIN RENDERS THE EDITABLE SUBSET
async function buildUsersPage(core, search = '', page = 1) {
  const where = search
    ? { OR: [{ username: { contains: search } }, { display_name: { contains: search } }] }
    : {};
  const raw = await core.prisma.user.findMany({
    where,
    orderBy: [{ is_client: 'desc' }, { username: 'asc' }],
    skip: (page - 1) * USERS_PAGE_SIZE,
    take: USERS_PAGE_SIZE + 1
  });
  return {
    rows: raw.slice(0, USERS_PAGE_SIZE).map(row => ({
      row: { ...row, avatar_url: rootRelative(row.avatar_url) },
      fields: core.models.user.getFormData(row)
    })),
    hasMore: raw.length > USERS_PAGE_SIZE,
    page,
    search
  };
}

// CONFIGURATION FORM GROUPS - EVERY EDITABLE FIELD LANDS IN A NAMED GROUP,
// UNLISTED NEWCOMERS FALL THROUGH TO 'Other' SO NOTHING SILENTLY VANISHES
const CONFIG_FIELD_GROUPS = [
  { label: 'General', blurb: 'What your media server goes by and the keyword that wakes the bot in chat.', keys: ['media_server_name', 'prefix_keyword'] },
  { label: 'Discord', blurb: 'The bot token that connects DiscoFlix to your Discord servers.', keys: ['discord_token'] },
  { label: 'Console Security', blurb: 'Password-protect this console and decide how long idle sessions live.', keys: ['admin_password', 'session_timeout'] },
  { label: 'Request Limits', blurb: 'Caps on lookups and what non-admin users are allowed to request.', keys: ['max_results', 'max_seasons_for_non_admin', 'max_check_time'] },
  { label: 'Extras', blurb: 'Nice-to-haves and diagnostics.', keys: ['is_trailers_enabled', 'is_debug'] }
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
async function buildSelfSectionData(core, instance, section) {
  const data = { configured: true, appUrl: null };
  switch (section) {
    case 'users': {
      data.users = await buildUsersPage(core);
      data.mutableFields = USER_MUTABLE_FIELDS;
      break;
    }
    case 'settings': {
      data.formGroups = buildConfigGroups(await core.models.configuration.getPages());
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
        enabled: state.discord_state
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
  if (instance.app_type === 'discoflix') return buildSelfSectionData(core, instance, section);
  const client = core.apps.getClientForInstance(instance);
  const configured = !!client;
  const data = { configured, appUrl: configured ? client.baseUrl : null };

  switch (section) {
    case 'overview': {
      if (!configured) {
        data.status = { ok: false, error: `${instance.display_name} is not configured` };
        data.health = [];
        data.queueCount = 0;
        break;
      }
      data.status = core.apps.statusCache.get(instance.id)
        || await core.apps.testInstance(instance);
      data.health = [];
      if (data.status.ok && client.capabilities.health) {
        try {
          data.health = (await client.getHealth()).map(item => ({
            type: item.type || 'warning',
            message: item.message || String(item)
          }));
        } catch (err) {
          core.logger.warn(`${instance.display_name} health fetch failed: ${err.message}`);
        }
      }
      data.queueCount = (core.apps.queueCache.get(instance.id) || []).length;
      break;
    }
    case 'queue': {
      data.queue = core.apps.queueCache.get(instance.id) || [];
      data.queueActions = core.apps.queueActionsFor(instance);
      break;
    }
    // ONE SURFACE, TWO SOURCES: THE ARR LISTING (BROWSE) OR LIVE SEARCH
    // RESULTS WHEN THE RAIL SEARCH BAR CARRIES A TERM - TIMES TWO VIEW
    // STYLES (COVER GRID / DETAILED ROWS, STICKY PER MODE)
    case 'library': {
      const manifest = core.apps.getType(instance.app_type);
      data.contentTypeLabel = manifest.contentTypes[0]?.label || 'item';
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
        data.library = configured
          ? await core.apps.getLibraryPage(instance, 1)
          : { items: [], total: 0, hasMore: false, page: 1 };
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
  // ANYWHERE DROPS THE SURFACE INTO THE LIBRARY SECTION'S SEARCH MODE
  const client = core.apps.getClientForInstance(instance);
  const railSearch = client && client.capabilities.search ? {
    term: String(opts.searchTerm || '').trim(),
    placeholder: `Search ${nav.appManifest.contentTypes[0]?.label || 'media'}s...`
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
async function respondWithMirror(ctx, state) {
  const core = ctx.core;
  const [msgObjects, servers, discordBot, members, apps, onboarding] = await Promise.all([
    core.discord.updateMessages(null, state),
    core.render.getServerTemplateObj(null, state),
    core.models.discordBot.get(),
    core.render.getServerMembers(state.active_server_id),
    core.apps.getRailViewModel(state),
    core.render.getOnboarding(state)
  ]);

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
    'members/membersLayout.pug'
  ], { servers, discordBot, messages, eomStamp, state, members, apps, onboarding });
}

// ── HANDLERS ─────────────────────────────────────────────────────────────

async function changeActiveApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const state = await core.models.state.update({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

// THE DISCORD BADGE'S ENTRY POINT - DISCOFLIX'S OWN TAKEOVER, ROW CREATED ON
// FIRST USE. LANDS ON THE LAST VIEWED SECTION LIKE ANY OTHER APP.
async function openDiscoFlix(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getSelfInstance();
  const state = await core.models.state.update({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

// THE BADGE'S HOVER COG (AND ONBOARDING CTAs) JUMP STRAIGHT TO A SECTION
async function openDiscoFlixSection(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getSelfInstance();
  const manifest = core.apps.getType('discoflix');
  const section = manifest.sections.includes(ctx.params.section)
    ? ctx.params.section
    : 'overview';
  await core.models.app.update({ id: instance.id }, { active_section: section });
  instance.active_section = section;
  const state = await core.models.state.update({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

// USERS SECTION SEARCH + PAGINATION - RETURNS BARE CARDS (AND THE NEXT
// SENTINEL) FOR #dfUserList
async function appUsersPage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return;
  }
  const page = Math.max(1, parseInt(ctx.query.page, 10) || 1);
  const search = String(ctx.query.search || '').trim();
  const users = await buildUsersPage(core, search, page);
  return ctx.compileView('apps/sections/dfUserCards.pug', {
    activeApp: instance,
    users,
    mutableFields: USER_MUTABLE_FIELDS
  });
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
  } catch (err) {
    core.logger.error('USER SAVE FAILED:', err);
    ctx.status = 400;
    ctx.body = { error: err.message };
    return;
  }

  return ctx.compileView(['apps/sections/dfUserCard.pug', 'extra/notification.pug'], {
    activeApp: instance,
    user: {
      row: { ...fresh, avatar_url: rootRelative(fresh.avatar_url) },
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

  let state = await core.models.state.get();
  if (state.active_app_id !== instance.id) {
    state = await core.models.state.update({ active_app_id: instance.id });
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

// LIBRARY PAGINATION - SAME REVEALED-SENTINEL TRICK AS THE FEED, SLICING THE
// TTL-CACHED FULL LISTING (SEE core.apps.getLibraryPage). PAGES RENDER IN
// WHATEVER VIEW STYLE THE BROWSE SURFACE CURRENTLY WEARS.
async function appLibraryPage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const page = Math.max(1, parseInt(ctx.params.page, 10) || 1);
  const library = await core.apps.getLibraryPage(instance, page);
  const manifest = core.apps.getType(instance.app_type);
  return ctx.compileView('apps/libraryCards.pug', {
    activeApp: instance,
    library,
    contentKind: manifest.contentTypes[0]?.type || 'movie',
    view: core.apps.getBrowseView(instance.id, 'library')
  });
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
  return ctx.compileView('apps/sections/libraryDetail.pug', {
    activeApp: instance,
    detail: detail || null,
    detailError: error || null,
    backTo: ctx.query.from === 'search' ? 'search' : 'library'
  });
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
  return ctx.compileView('apps/sections/libraryDetail.pug', locals);
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
  return ctx.compileView(['apps/sections/libraryDetail.pug', 'extra/notification.pug'], {
    activeApp: instance,
    detail: detail || null,
    detailError: error || null,
    backTo: ctx.request.body?.from === 'search' ? 'search' : 'library',
    message
  });
}

// THE RAIL SEARCH BAR'S ROUTE: A TERM DROPS THE TAKEOVER INTO THE LIBRARY
// SECTION'S SEARCH MODE (THE INPUT LIVES IN THE UNTOUCHED RIGHT RAIL, SO THE
// TRANSITION IS SEAMLESS); AN EMPTY TERM FALLS BACK TO BROWSING. CROSS-
// INSTANCE CALLS (ADD-TO TABS) ENTER THAT APP'S TAKEOVER, TERM RIDING ALONG.
// ?view= ALSO SERVES THE COVERS/DETAILED TOGGLE - SAME RENDER, NEW STYLE.
async function appSearch(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  const manifest = instance && core.apps.getType(instance.app_type);
  if (!instance || !manifest || !manifest.sections.includes('library')) {
    ctx.status = 404;
    return;
  }

  const term = String(ctx.query.term || '').trim();
  const view = String(ctx.query.view || '').trim();
  if (view) core.apps.setBrowseView(instance.id, term ? 'search' : 'library', view);

  let state = await core.models.state.get();
  // CLEARING THE BOX ONLY MEANS SOMETHING ON THE LIBRARY SURFACE - FROM ANY
  // OTHER SECTION AN EMPTY TERM MUST NOT YANK THE VIEW AROUND
  if (!term && !view && (state.active_app_id !== instance.id || instance.active_section !== 'library')) {
    ctx.status = 204;
    return;
  }

  if (instance.active_section !== 'library') {
    await core.models.app.update({ id: instance.id }, { active_section: 'library' });
    instance.active_section = 'library';
  }

  if (state.active_app_id !== instance.id) {
    state = await core.models.state.update({ active_app_id: instance.id });
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
          requesterIds: []
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
    return ctx.compileView(['apps/sections/libraryDetail.pug', 'extra/notification.pug'], locals);
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
  const state = await core.models.state.update({ active_app_id: instance.id });
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

  const state = await core.models.state.get();
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

  const state = await core.models.state.get();
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

  // THE FK ALREADY SetNull'D active_app_id; THE EXPLICIT UPDATE JUST GETS US
  // A FRESH state ROW AND COVERS REMOVING A NON-ACTIVE APP THE SAME WAY
  const state = await core.models.state.update({ active_app_id: null });
  return respondWithMirror(ctx, state);
}

module.exports = {
  buildAppRail,
  buildSectionNav,
  buildTakeoverLocals,
  changeActiveApp,
  openDiscoFlix,
  openDiscoFlixSection,
  appUsersPage,
  saveAppUser,
  changeAppSection,
  appFeedPage,
  appLibraryPage,
  appLibraryItem,
  appLookupDetail,
  appLibraryItemAction,
  appSearch,
  appAddMedia,
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
