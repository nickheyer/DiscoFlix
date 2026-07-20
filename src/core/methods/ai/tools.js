const registry = require('../apps/registry');
const { resolveFeature, userTier, TIER_RANK } = require('../../bot/interactions/features');
const { countRequestsSince } = require('../../bot/interactions/limits');

// THE AI TOOL SURFACE - EVERYTHING THE ASSISTANT CAN SEE OR DO, EACH VERB A
// THIN WRAPPER OVER THE SAME core.apps PATHS THE BOT AND CONSOLE USE. TOOLS
// NEVER BYPASS RBAC: DISCORD CALLS RESOLVE THE CALLER'S OWN FEATURE GATES
// (request.movie, whatsnew, status...) AND A DENIAL COMES BACK AS AN
// EXPLAINED TOOL RESULT THE MODEL RELAYS - THE AI HAS EXACTLY THE POWERS OF
// WHOEVER IS TALKING TO IT. THE CONSOLE SURFACE IS THE OPERATOR: UNGATED,
// PLUS APPROVE/DENY VERBS DISCORD NEVER GETS.
//
// EVERY run() RETURNS A STRING (USUALLY JSON). THROWN ERRORS BECOME
// is_error TOOL RESULTS SO THE MODEL CAN EXPLAIN AND RECOVER.

// RESULT CAPS READ FROM ctx.core.tuning AT CALL TIME (ai_tool_search_cap /
// ai_tool_list_cap) SO ADMIN CHANGES APPLY LIVE

function contentTypeEnum() {
  return registry.contentTypeDefs().map(def => def.type);
}

function trimOverview(text, max = 220) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

// DISCORD-ONLY FEATURE GATE INSIDE A TOOL - CONSOLE IS THE OPERATOR
async function gateFor(ctx, featureId) {
  if (ctx.surface !== 'discord') return { allowed: true, extents: {} };
  return resolveFeature(ctx.core, featureId, ctx);
}

function deniedText(gate) {
  return JSON.stringify({ denied: true, reason: gate.denialMessage || 'Not allowed here.' });
}

// ── THE TOOLBOX ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_media',
    surfaces: ['discord', 'console'],
    description: 'Search the connected media apps for a movie, show, or album. Call this before requesting anything, and whenever the user asks whether a title exists, is available, or could be added. Returns candidates with an external_id needed by request_media.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: contentTypeEnum(), description: 'What kind of media to search for' },
        query: { type: 'string', description: 'Title to search, e.g. "dune part two"' }
      },
      required: ['type', 'query']
    },
    async run(ctx, input) {
      const { core } = ctx;
      const instance = await core.apps.defaultInstanceFor(input.type);
      if (!instance) return JSON.stringify({ error: `No connected app handles ${input.type} searches - one can be added in the web console.` });
      const client = core.apps.getClientForInstance(instance);
      let results = await client.search(String(input.query || '').trim());
      results = results.slice(0, core.tuning.value('ai_tool_search_cap'));
      let badges = null;
      try {
        badges = await core.apps.annotateAvailability(results, client);
      } catch (err) {
        core.logger.debug(`AI availability badges skipped: ${err.message}`);
      }
      return JSON.stringify({
        app: instance.display_name,
        results: results.map((result, i) => ({
          title: result.title,
          year: result.year || null,
          external_id: String(result.externalKey ?? ''),
          overview: trimOverview(result.overview),
          ...(result.seasonCount ? { seasons: result.seasonCount } : {}),
          ...(badges?.[i] ? { availability: badges[i].text } : {})
        }))
      });
    }
  },

  {
    name: 'request_media',
    surfaces: ['discord', 'console'],
    description: 'Request a title so it gets downloaded and added to the media server. Only call after search_media returned the title, using its exact external_id - and only when the user clearly wants it added (confirm first if they were just browsing). For shows, an optional seasons array limits the request to those season numbers.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: contentTypeEnum(), description: 'Media kind, matching the search' },
        external_id: { type: 'string', description: 'The external_id from search_media results' },
        title: { type: 'string', description: 'The title, used to re-run the search' },
        seasons: { type: 'array', items: { type: 'integer' }, description: 'Optional season numbers for shows - omit for all seasons' }
      },
      required: ['type', 'external_id', 'title']
    },
    async run(ctx, input) {
      return requestMedia(ctx, input);
    }
  },

  {
    name: 'media_library',
    surfaces: ['discord', 'console'],
    description: 'Look up what is already in the combined library across every connected app. Call this when the user asks what the server has, whether something is downloaded, or for library counts - and proactively whenever you are about to recommend or discuss specific titles, so you know what is already sitting here before you speak. Searches by title when query is given.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional title filter' },
        kind: { type: 'string', enum: ['all', 'movie', 'show', 'music'], description: 'Optional kind filter (default all)' }
      },
      required: []
    },
    async run(ctx, input) {
      const listCap = ctx.core.tuning.value('ai_tool_list_cap');
      const page = await ctx.core.apps.getUnifiedPage({
        term: String(input.query || ''),
        kind: input.kind && input.kind !== 'all' ? input.kind : 'all'
      });
      return JSON.stringify({
        counts: page.counts,
        showing: Math.min(page.items.length, listCap),
        items: page.items.slice(0, listCap).map(item => ({
          title: item.title,
          year: item.year || null,
          kind: item.kind,
          ...(item.seasonCount ? { seasons: item.seasonCount } : {}),
          on: item.sources.map(source => source.label),
          available: item.sources.some(source => source.available)
        }))
      });
    }
  },

  {
    name: 'whats_new',
    surfaces: ['discord', 'console'],
    description: 'Recently added titles across the connected media servers. Call when the user asks what is new, recent, or just added - fresh arrivals are usually promising.',
    input_schema: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      const gate = await gateFor(ctx, 'whatsnew');
      if (!gate.allowed) return deniedText(gate);
      const { core } = ctx;
      const rows = await core.models.app.getMany({ enabled: true });
      const servers = rows.filter(row =>
        core.apps.getType(row.app_type)?.kind === 'media-server' && core.apps.isConfigured(row)
      );
      if (!servers.length) return JSON.stringify({ error: 'No media server is connected.' });
      const added = [];
      for (const server of servers) {
        const feed = await core.apps.getFeedViewModel(server);
        for (const row of (feed.rows || []).filter(r => r.kind === 'added')) {
          added.push({ title: row.title, detail: row.detail || null, at: row.at || null, on: server.display_name });
        }
      }
      added.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      return JSON.stringify({ recently_added: added.slice(0, core.tuning.value('ai_tool_list_cap')) });
    }
  },

  {
    name: 'download_queue',
    surfaces: ['discord', 'console'],
    description: 'What is downloading right now across every connected app, with progress and ETA. Call when the user asks about download status or when something they requested will be ready.',
    input_schema: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      const gate = await gateFor(ctx, 'status');
      if (!gate.allowed) return deniedText(gate);
      const { core } = ctx;
      const rows = await core.models.app.getMany({ enabled: true });
      const queue = [];
      for (const row of rows) {
        for (const item of core.apps.queueCache.get(row.id) || []) {
          queue.push({
            title: item.title,
            progress: `${item.percent}%`,
            status: item.status,
            ...(item.timeleft ? { time_left: item.timeleft } : {}),
            on: row.display_name
          });
        }
      }
      return JSON.stringify(queue.length ? { downloading: queue.slice(0, core.tuning.value('ai_tool_list_cap')), total: queue.length } : { downloading: [], note: 'The queue is empty.' });
    }
  },

  {
    name: 'now_playing',
    surfaces: ['discord', 'console'],
    description: 'Active streams on the media servers - who is watching what. Staff-only on Discord.',
    input_schema: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      // WHO-IS-WATCHING IS OPERATOR-GRADE INFO - staff+ IN DISCORD
      if (ctx.surface === 'discord' && userTier(ctx.dbUser) < TIER_RANK.staff) {
        return JSON.stringify({ denied: true, reason: 'Now Playing is staff-only.' });
      }
      const { core } = ctx;
      const rows = await core.models.app.getMany({ enabled: true });
      const playing = [];
      for (const row of rows) {
        const manifest = core.apps.getType(row.app_type);
        if (manifest?.kind !== 'media-server' || !core.apps.isConfigured(row)) continue;
        const { sessions } = await core.apps.getSessionsFor(row);
        for (const session of sessions || []) {
          playing.push({
            title: session.title,
            ...(session.subtitle ? { detail: session.subtitle } : {}),
            user: session.user,
            state: session.state,
            progress: `${session.percent}%`,
            on: row.display_name
          });
        }
      }
      return JSON.stringify(playing.length ? { streams: playing } : { streams: [], note: 'Nobody is streaming right now.' });
    }
  },

  {
    name: 'service_status',
    surfaces: ['discord', 'console'],
    description: 'Health of the whole setup: every connected app with reachability and version, plus the Discord bot state. Call when the user asks if things are up, down, or broken.',
    input_schema: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      const gate = await gateFor(ctx, 'status');
      if (!gate.allowed) return deniedText(gate);
      const { core } = ctx;
      const rows = await core.models.app.getMany({});
      const services = rows
        .filter(row => !core.apps.getType(row.app_type)?.hidden)
        .map(row => {
          const manifest = core.apps.getType(row.app_type) || {};
          const status = core.apps.statusCache.get(row.id);
          return {
            name: row.display_name,
            type: manifest.label || row.app_type,
            kind: manifest.kind || 'app',
            enabled: row.enabled,
            configured: core.apps.isConfigured(row),
            reachable: status ? status.ok : null,
            ...(status?.version ? { version: status.version } : {}),
            ...(status?.ok === false && status.error ? { problem: status.error } : {})
          };
        });
      return JSON.stringify({
        bot_online: !!(core.client && core.client.isReady()),
        services
      });
    }
  },

  {
    name: 'open_requests',
    surfaces: ['discord', 'console'],
    description: 'Recent media requests and where they stand (pending approval, approved, denied, downloaded). Use filter "mine" for the current user\'s own requests, "pending" for ones awaiting an admin.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'mine', 'pending'], description: 'Which requests to list (default all)' }
      },
      required: []
    },
    async run(ctx, input) {
      const { core } = ctx;
      const where = {};
      if (input.filter === 'pending') where.status = null;
      if (input.filter === 'mine') {
        if (!ctx.dbUser) return JSON.stringify({ error: 'No user context - "mine" only works from Discord.' });
        where.users = { some: { id: ctx.dbUser.id } };
      }
      const rows = await core.prisma.mediaRequest.findMany({
        where,
        include: { media: true, users: true },
        orderBy: { created_at: 'desc' },
        take: core.tuning.value('ai_tool_list_cap')
      });
      return JSON.stringify({
        requests: rows.map(row => ({
          id: row.id,
          title: row.media?.title || row.orig_parsed_title,
          type: row.orig_parsed_type,
          state: row.status === null ? 'pending approval' : (row.status ? (row.media?.is_available ? 'downloaded' : 'approved') : 'denied'),
          requested_by: (row.users || []).map(user => user.display_name || user.username),
          when: row.created_at
        }))
      });
    }
  },

  {
    name: 'approve_request',
    surfaces: ['console'],
    description: 'Approve a pending media request by id (from open_requests) - the title is sent to its app and starts downloading. Operator console only; confirm with the operator before approving anything they did not explicitly name.',
    input_schema: {
      type: 'object',
      properties: { request_id: { type: 'string', description: 'The request id from open_requests' } },
      required: ['request_id']
    },
    async run(ctx, input) {
      const outcome = await ctx.core.apps.approveMediaRequest(String(input.request_id));
      ctx.core.apps.pushRequestCard(String(input.request_id)).catch(() => {});
      return JSON.stringify(outcome);
    }
  },

  {
    name: 'deny_request',
    surfaces: ['console'],
    description: 'Deny a pending media request by id (from open_requests). Operator console only; confirm with the operator before denying anything they did not explicitly name.',
    input_schema: {
      type: 'object',
      properties: { request_id: { type: 'string', description: 'The request id from open_requests' } },
      required: ['request_id']
    },
    async run(ctx, input) {
      const outcome = await ctx.core.apps.denyMediaRequest(String(input.request_id));
      ctx.core.apps.pushRequestCard(String(input.request_id)).catch(() => {});
      return JSON.stringify(outcome);
    }
  }
];

// ── REQUEST FULFILLMENT (MIRRORS request.js finalizeSelection, MINUS THE
// INTERACTIVE CARD - THE CONVERSATION *IS* THE CARD) ─────────────────────

async function requestMedia(ctx, input) {
  const { core } = ctx;
  const type = String(input.type || '');
  const contentDef = registry.contentTypeDefs().find(def => def.type === type);
  if (!contentDef) return JSON.stringify({ error: `Unknown media type '${type}'.` });

  // THE CALLER'S OWN REQUEST GATE - EXACTLY WHAT /movie ETC. WOULD ENFORCE
  const gate = await gateFor(ctx, `request.${type}`);
  if (!gate.allowed) return deniedText(gate);
  const extents = gate.extents || {};

  if (ctx.surface === 'discord') {
    const dailyLimit = Number(extents.max_requests_per_day) || 0;
    if (dailyLimit > 0 && (await countRequestsSince(core, ctx.dbUser)) >= dailyLimit) {
      return JSON.stringify({ denied: true, reason: `Daily limit reached - ${dailyLimit} request${dailyLimit === 1 ? '' : 's'} per day.` });
    }
  }

  const instance = await core.apps.defaultInstanceFor(type);
  if (!instance) return JSON.stringify({ error: `No connected app handles ${type} requests.` });
  const client = core.apps.getClientForInstance(instance);

  // RE-FIND THE EXACT RESULT BY ITS EXTERNAL ID - NEVER TRUST A FUZZY TITLE
  const results = await client.search(String(input.title || '').trim());
  const result = results.find(candidate => String(candidate.externalKey) === String(input.external_id));
  if (!result) {
    return JSON.stringify({ error: `No search result matched external_id ${input.external_id} - run search_media again and use an exact external_id.` });
  }
  const name = result.year ? `${result.title} (${result.year})` : result.title;

  // SEASON PICKS + THE SEASON CAP (SHOWS)
  let seasons = Array.isArray(input.seasons) && input.seasons.length
    ? [...new Set(input.seasons.map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
    : null;
  if (result.contentType !== 'show') seasons = null;
  const seasonLimit = Number(extents.max_seasons) || 0;
  const effectiveSeasonCount = seasons ? seasons.length : (result.seasonCount || 0);
  if (seasonLimit > 0 && effectiveSeasonCount > seasonLimit) {
    return JSON.stringify({ denied: true, reason: `That's ${effectiveSeasonCount} seasons - the cap here is ${seasonLimit}. Pick specific seasons instead.` });
  }

  // ALREADY STREAMABLE? EVERY CONNECTED MEDIA SERVER ANSWERS FIRST - GUARDED
  try {
    const streaming = await core.apps.findOnMediaServers(result);
    if (streaming.length) {
      const names = streaming.map(match => match.instance.display_name).join(', ');
      return JSON.stringify({ status: 'already-available', note: `${name} is already streamable on ${names}.` });
    }
  } catch (err) {
    core.logger.debug(`AI availability check skipped: ${err.message}`);
  }

  // ALREADY IN THE LIBRARY?
  const existing = await client.getByExternalId(result.externalKey);
  if (existing) {
    if (client.isImported(existing)) {
      return JSON.stringify({ status: 'already-available', note: `${name} is already in the library.` });
    }
    const media = await core.models.media.findByResult(result);
    const openRequest = media
      ? await core.models.mediaRequest.findFirst({ mediaId: media.id, status: null })
      : null;
    if (openRequest && ctx.dbUser) {
      await core.models.mediaRequest.addUser(openRequest.id, ctx.dbUser.id);
      return JSON.stringify({ status: 'already-requested', note: `${name} was already requested - the user has been added to it.` });
    }
    return JSON.stringify({ status: 'already-requested', note: `${name} is already on the download list.` });
  }

  // CONSOLE = OPERATOR, ALWAYS STRAIGHT TO THE APP; DISCORD FOLLOWS THE
  // CALLER'S auto-approve GRANT LIKE THE CARD FLOW DOES
  const autoApprove = ctx.surface === 'console'
    ? { allowed: true }
    : await resolveFeature(core, 'request.auto-approve', ctx);

  const requestBase = {
    madeInId: ctx.guildId || null,
    orig_message: ctx.origContent ? `ai-chat: ${String(ctx.origContent).slice(0, 400)}` : `ai-chat request: ${name}`,
    orig_parsed_title: result.title,
    orig_parsed_type: type,
    orig_channel_id: ctx.channel?.id || null,
    orig_message_id: ctx.messageId || null,
    seasons: seasons ? JSON.stringify(seasons) : null,
    appId: instance.id,
    ...(ctx.dbUser ? { users: { connect: { id: ctx.dbUser.id } } } : {})
  };
  const seasonNote = seasons ? ` (season${seasons.length === 1 ? '' : 's'} ${seasons.join(', ')})` : '';

  if (autoApprove.allowed) {
    const added = await client.add(result, { seasons });
    const media = await core.models.media.upsertFromResult(result, added);
    const request = await core.models.mediaRequest.createRequest({
      ...requestBase,
      mediaId: media.id,
      arr_id: String(added.id),
      status: true
    });
    core.apps.watchRequest({
      requestId: request.id,
      appId: instance.id,
      arrId: added.id,
      mediaId: media.id,
      title: name,
      channelId: ctx.channel?.id || null,
      requesterIds: ctx.dbUser ? [ctx.dbUser.id] : [],
      featureId: `request.${type}`,
      serverId: ctx.guildId || null
    });
    core.logger.info(`Media request created via AI chat: ${name}${seasonNote} (${instance.display_name})`);
    core.discord.refreshUI().catch(() => {});
    return JSON.stringify({
      status: 'requested',
      note: `${name}${seasonNote} was sent to ${instance.display_name} and will download shortly.${ctx.channel ? ' Progress updates will post in this channel.' : ''}`
    });
  }

  const media = await core.models.media.upsertFromResult(result);
  await core.models.mediaRequest.createRequest({ ...requestBase, mediaId: media.id, status: null });
  core.logger.info(`Media request pending approval via AI chat: ${name}${seasonNote} (${instance.display_name})`);
  core.discord.refreshUI().catch(() => {});
  return JSON.stringify({
    status: 'pending-approval',
    note: `${name}${seasonNote} was submitted - an admin has to approve it before it downloads.`
  });
}

// ── DISPATCH ─────────────────────────────────────────────────────────────

module.exports = {
  // THE CATALOG ITSELF - THE DIRECTIVES TAB READS descriptions AS DEFAULTS
  TOOLS,

  // PROVIDER-NEUTRAL DEFINITIONS FOR ONE SURFACE. DESCRIPTIONS COME THROUGH
  // THE DIRECTIVE CATALOG (tool.<name> KEYS) SO THE DIRECTIVES TAB CAN
  // RE-BRIEF A TOOL PER INSTANCE; SCHEMAS ARE FIXED, BUT BRIEFING TEXT
  // SPEAKS THE UNIVERSAL {var} SET LIKE EVERY OTHER DIRECTIVE. LAZY
  // REQUIRE - directives.js READS TOOLS FROM HERE (CYCLE-SAFE).
  async aiToolDefinitionsFor(toolCtx) {
    const { directiveText } = require('./directives');
    const vars = await this.directiveVarsFor(toolCtx.instance);
    return TOOLS
      .filter(tool => tool.surfaces.includes(toolCtx.surface))
      .map(tool => ({
        name: tool.name,
        description: directiveText(toolCtx.instance, `tool.${tool.name}`, vars),
        input_schema: tool.input_schema
      }));
  },

  // ONE tool_use BLOCK -> ONE tool_result BLOCK. FAILURES COME BACK AS
  // is_error RESULTS SO THE MODEL EXPLAINS INSTEAD OF THE TURN DYING.
  async executeAiTool(toolCtx, use) {
    const tool = TOOLS.find(candidate => candidate.name === use.name);
    if (!tool || !tool.surfaces.includes(toolCtx.surface)) {
      return { type: 'tool_result', tool_use_id: use.id, content: `Unknown tool: ${use.name}`, is_error: true };
    }
    try {
      const content = await tool.run(toolCtx, use.input || {});
      return { type: 'tool_result', tool_use_id: use.id, content: String(content ?? '') };
    } catch (err) {
      this.logger.warn(`AI tool ${use.name} failed: ${err.message}`);
      return { type: 'tool_result', tool_use_id: use.id, content: `Error: ${err.message}`, is_error: true };
    }
  }
};
