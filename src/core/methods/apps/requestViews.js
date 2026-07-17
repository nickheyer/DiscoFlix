const STATE_LABELS = {
  pending: 'Pending',
  denied: 'Denied',
  approved: 'Approved - searching',
  downloading: 'Downloading',
  available: 'Available'
};

const REQUESTS_PAGE_SIZE = 20;

// TAB FILTERS FOR THE REQUESTS SECTION - active/done SPLIT APPROVED ROWS BY
// WHETHER THE MEDIA LANDED (is_available RIDES THE LEDGER, NOT THE REQUEST)
const REQUEST_FILTERS = {
  all: {},
  pending: { status: null },
  active: { status: true, media: { is_available: false } },
  done: { status: true, media: { is_available: true } },
  denied: { status: false }
};

// CACHED IMAGES ARE STORED AS BARE RELATIVE PATHS - SERVE THEM ROOT-RELATIVE
function rootRelative(path) {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `/${String(path).replace(/^\/+/, '')}`;
}

function shortStamp(timestamp) {
  if (!timestamp) return null;
  const stamp = new Date(timestamp);
  if (isNaN(stamp.getTime())) return null;
  const sameYear = stamp.getFullYear() === new Date().getFullYear();
  return stamp.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  });
}

// STATE + VIEW-MODEL DERIVATION FOR MediaRequest - THE ENGINE BEHIND THE
// REQUESTS SECTION, THE CHAT MIRROR'S INLINE CARDS, AND LIBRARY ORIGIN ROWS
module.exports = {
  REQUESTS_PAGE_SIZE,
  REQUEST_FILTERS,

  // REQUEST MUST INCLUDE MEDIA RELATION
  stateOf(request, queueRecord = null) {
    if (request.status === false) return 'denied';
    if (request.status === null) return 'pending';
    if (request.media?.is_available) return 'available';
    if (queueRecord) return 'downloading';
    const watch = this.watches.get(request.id);
    if (watch && watch.stage === 'grabbed') return 'downloading';
    return 'approved';
  },

  stateLabel(state) {
    return STATE_LABELS[state] || state;
  },

  // QUEUE ROWS ARRIVE PRE-NORMALIZED FROM THE CLIENTS (percent/timeleft)
  progressOf(queueRow) {
    if (!queueRow) return null;
    return { percent: queueRow.percent ?? 0, timeleft: queueRow.timeleft || null };
  },

  // request MUST INCLUDE media + users (+ made_in IF SERVER NAME WANTED).
  // opts: { channelName, config, msIndexes, withStages } - THE SECTION'S
  // PIPELINE EXTRAS ARE OPT-IN SO CHAT RENDERS STAY CHEAP
  buildRequestView(request, queueRecord = null, opts = {}) {
    const state = this.stateOf(request, queueRecord);
    const media = request.media || {};
    let seasons = null;
    try { seasons = request.seasons ? JSON.parse(request.seasons) : null; } catch (err) { seasons = null; }
    const view = {
      id: request.id,
      title: media.year ? `${media.title} (${media.year})` : (media.title || request.orig_parsed_title),
      posterUrl: media.poster_url || null,
      contentType: request.orig_parsed_type,
      state,
      stateLabel: this.stateLabel(state),
      progress: state === 'downloading' ? this.progressOf(queueRecord) : null,
      appId: request.appId || null,
      appLabel: request.app?.display_name || null,
      // DEEP-LINK BACK TO THE TRIGGERING MESSAGE - ALL THREE OR NOTHING
      canJump: !!(request.orig_message_id && request.orig_channel_id && request.madeInId),
      // NO USERS + NO GUILD = OPERATOR ADD FROM THE CONSOLE'S SEARCH & ADD
      requestedBy: (request.users || []).map(user => user.display_name || user.username).join(', ')
        || (!request.madeInId ? 'Console' : ''),
      // AVATAR CHIPS - EACH ONE OPENS THE USER PROFILE MODAL
      requesters: (request.users || []).map(user => ({
        id: user.id,
        name: user.display_name || user.username,
        avatarUrl: rootRelative(user.avatar_url)
      })),
      serverName: request.made_in?.server_name || null,
      channelName: opts.channelName || null,
      origMessage: request.orig_message,
      requestedAt: request.created_at,
      requestedAtLabel: shortStamp(request.created_at),
      seasonsLabel: Array.isArray(seasons) && seasons.length
        ? `Season${seasons.length > 1 ? 's' : ''} ${seasons.join(', ')}`
        : null
    };
    if (opts.withStages) {
      view.stages = this.stagesOf(request, {
        state,
        queueRow: queueRecord,
        channelName: opts.channelName || null,
        config: opts.config || null,
        msIndexes: opts.msIndexes || null,
        appLabel: view.appLabel
      });
    }
    return view;
  },

  // THE PIPELINE: REQUESTED -> DECISION -> INDEXER -> DOWNLOAD -> IMPORTED ->
  // MEDIA SERVER. EVERY DETAIL STATES ONLY WHAT THE DATA ACTUALLY KNOWS -
  // A DENIED ROW ENDS THE ARRAY (DEAD PIPELINES DRAW NO FUTURE STOPS)
  stagesOf(request, { state, queueRow, channelName, config, msIndexes, appLabel }) {
    const watch = this.watches.get(request.id);
    const media = request.media || {};
    const indexerLabel = appLabel || 'Indexer';
    const stages = [];

    const whereFrom = request.madeInId
      ? `by ${(request.users || []).map(user => user.display_name || user.username).join(', ') || 'unknown user'}`
        + (channelName ? ` in #${channelName}` : '')
        + (request.made_in?.server_name ? ` · ${request.made_in.server_name}` : '')
      : 'via the console';
    stages.push({
      key: 'requested', label: 'Requested', state: 'done',
      detail: whereFrom, at: request.created_at, atLabel: shortStamp(request.created_at)
    });

    if (request.status === false) {
      stages.push({
        key: 'decision', label: 'Decision', state: 'failed',
        detail: 'Denied', at: request.decided_at, atLabel: shortStamp(request.decided_at)
      });
      return stages;
    }
    if (request.status === null) {
      stages.push({
        key: 'decision', label: 'Decision', state: 'active',
        detail: 'Waiting for approval', at: null, atLabel: null
      });
      // NEVER GUESS THE INSTANCE PRE-APPROVAL - THE OVERRIDE SELECT CAN MOVE IT
      stages.push({ key: 'indexer', label: 'Indexer', state: 'pending', detail: null, at: null, atLabel: null });
    } else {
      stages.push({
        key: 'decision', label: 'Decision', state: 'done',
        detail: appLabel ? `Sent to ${appLabel}` : 'Approved',
        at: request.decided_at, atLabel: shortStamp(request.decided_at)
      });
      if (request.arr_id) {
        stages.push({
          key: 'indexer', label: indexerLabel, state: 'done',
          detail: request.appId ? 'Added' : 'The handling app was removed',
          at: request.decided_at, atLabel: shortStamp(request.decided_at),
          // JUMP TO THE ITEM'S DETAIL IN THE HANDLING APP - ONLY WHEN THE
          // APP STILL EXISTS TO SERVE IT
          link: request.appId
            ? { appId: request.appId, itemId: request.arr_id, tip: `Open in ${indexerLabel}` }
            : null
        });
      } else {
        // LEGACY/FAILED ADD - APPROVED BUT NO SERVICE ITEM ID ON RECORD
        stages.push({
          key: 'indexer', label: indexerLabel, state: 'pending',
          detail: 'Not sent to an app yet', at: null, atLabel: null
        });
      }
    }

    const imported = !!media.is_available;
    let download;
    if (imported) {
      download = { state: 'done', detail: 'Downloaded', progress: null };
    } else if (queueRow) {
      const client = queueRow.downloadClient ? ` · ${queueRow.downloadClient}` : '';
      const eta = queueRow.timeleft ? ` · ${queueRow.timeleft} left` : '';
      download = /import/i.test(queueRow.status || '') || /completed/i.test(queueRow.status || '')
        ? { state: 'active', detail: `Importing${client}`, progress: null }
        : {
          state: 'active',
          detail: `${Math.round(queueRow.percent || 0)}%${eta}${client}`,
          progress: this.progressOf(queueRow)
        };
    } else if (watch && watch.stage === 'grabbed') {
      download = { state: 'active', detail: 'Left the queue - importing or failed', progress: null };
    } else if (watch) {
      download = { state: 'pending', detail: 'Waiting for a grab', progress: null };
    } else if (request.status === true) {
      // THE WATCH EXPIRED (max_check_time) - SAY SO INSTEAD OF FREEZING A BAR
      download = { state: 'pending', detail: `No longer watched - check ${indexerLabel}`, progress: null };
    } else {
      download = { state: 'pending', detail: null, progress: null };
    }
    stages.push({
      key: 'download', label: 'Download', at: null, atLabel: null, ...download,
      // AN UNFINISHED DOWNLOAD LIVES IN THE HANDLING APP'S QUEUE - JUMP THERE
      link: !imported && request.status === true && request.appId
        ? { appId: request.appId, section: 'queue', tip: `Open the ${indexerLabel} queue` }
        : null
    });

    stages.push({
      key: 'imported', label: 'Imported', state: imported ? 'done' : 'pending',
      detail: imported ? `Imported into ${indexerLabel}` : null,
      at: imported ? request.imported_at : null,
      atLabel: imported ? shortStamp(request.imported_at) : null,
      link: imported && request.appId && request.arr_id
        ? { appId: request.appId, itemId: request.arr_id, tip: `Open in ${indexerLabel}` }
        : null
    });

    // NO MEDIA-SERVER STAGE WITHOUT A MEDIA SERVER - CLAIMING ONE WOULD LIE
    if (msIndexes && msIndexes.length) {
      const hits = imported ? this.mediaServerHits(request, msIndexes) : [];
      stages.push({
        key: 'mediaserver',
        label: config?.media_server_name || 'Media server',
        state: imported ? 'done' : 'pending',
        detail: imported
          ? (hits.length ? hits.map(hit => `On ${hit.name}`).join(' · ') : 'Marked available on import')
          : null,
        at: null, atLabel: null,
        // FIRST CONFIRMING SERVER'S OWN ITEM DETAIL - CACHE HITS CARRY THE
        // SERVICE ITEM ID, SO THE JUMP LANDS ON THE REAL THING
        link: hits.length
          ? { appId: hits[0].appId, itemId: hits[0].itemId, tip: `Open on ${hits[0].name}` }
          : null
      });
    }
    return stages;
  },

  // CACHE-ONLY MEDIA-SERVER INDEXES - THE PIPELINE CONFIRMS PRESENCE FROM
  // WARM libraryCache ENTRIES ONLY; A LIST RENDER NEVER ISSUES LIVE HTTP
  // (THE HEARTBEAT AND TAKEOVER VIEWS KEEP THESE WARM IN PRACTICE)
  async mediaServerCacheIndexes() {
    const rows = await this.core.models.app.getMany({ enabled: true });
    const indexes = [];
    for (const row of rows) {
      if (this.getType(row.app_type)?.kind !== 'media-server' || !this.isConfigured(row)) continue;
      const cached = this.libraryCache.get(row.id);
      if (!cached) continue;
      const byId = { tmdb: new Map(), imdb: new Map(), tvdb: new Map() };
      const byTitle = new Map();
      for (const item of cached.items) {
        const ids = item.externalIds || {};
        for (const key of ['tmdb', 'imdb', 'tvdb']) {
          if (ids[key]) byId[key].set(`${item.kind}:${ids[key]}`, item);
        }
        const title = this.comparableTitle(item.title);
        if (title && !byTitle.has(`${item.kind}:${title}`)) byTitle.set(`${item.kind}:${title}`, item);
      }
      indexes.push({ instance: row, byId, byTitle });
    }
    return indexes;
  },

  // EVERY SERVER THAT CAN CONFIRM THE REQUEST'S MEDIA FROM ITS WARM CACHE -
  // { name, appId, itemId } PER HIT SO THE PIPELINE CAN DEEP-LINK THE DETAIL.
  // MUSIC NEVER MATCHES - MEDIA-SERVER NORMALIZERS ONLY EMIT movie/show
  mediaServerHits(request, msIndexes) {
    const media = request.media || {};
    if (request.orig_parsed_type === 'music') return [];
    const result = {
      contentType: request.orig_parsed_type,
      tmdbId: media.tmdb_id,
      imdbId: media.imdb_id,
      tvdbId: media.tvdb_id,
      title: media.title,
      year: media.year
    };
    const hits = [];
    for (const index of msIndexes) {
      const match = this._matchInIndexes([index], result);
      if (match) {
        hits.push({ name: index.instance.display_name, appId: index.instance.id, itemId: match.item.id });
      }
    }
    return hits;
  },

  // contentType -> [{ id, label, isDefault }] FOR THE PER-CARD INSTANCE
  // OVERRIDE SELECT (ONLY MEANINGFUL WHEN MORE THAN ONE SERVES THE TYPE)
  async buildInstanceOptions() {
    const options = {};
    for (const def of this.contentTypeDefs()) {
      const instances = await this.instancesForContentType(def.type);
      options[def.type] = instances.map(instance => ({
        id: instance.id,
        label: instance.display_name,
        isDefault: instance.is_default
      }));
    }
    return options;
  },

  // QUEUE ROWS FOR A BATCH OF REQUESTS - queueCache FIRST (HEARTBEAT KEEPS IT
  // <=60s STALE), ONE GUARDED LIVE FETCH PER APP ONLY WHEN ASKED TO
  async _queueRowsFor(requests, { liveFallback = false } = {}) {
    const byApp = new Map();
    for (const request of requests) {
      const watch = this.watches.get(request.id);
      if (!watch) continue;
      if (!byApp.has(watch.appId)) byApp.set(watch.appId, []);
      byApp.get(watch.appId).push({ request, watch });
    }

    const rows = new Map(); // requestId -> queueRow
    for (const [appId, entries] of byApp) {
      const instance = await this.getInstance(appId);
      const client = instance?.enabled ? this.getClientForInstance(instance) : null;
      if (!client) continue;
      let queue = this.queueCache.get(appId);
      if (!queue && liveFallback) {
        try {
          queue = await client.getQueue();
          this.queueCache.set(appId, queue);
        } catch (err) {
          this.logger.warn(`Requests view could not read ${instance.display_name} queue: ${err.message}`);
          continue;
        }
      }
      if (!queue) continue;
      for (const { request, watch } of entries) {
        const row = queue.find(record => client.matchesQueueRecord(record, watch.arrId));
        if (row) rows.set(request.id, row);
      }
    }
    return rows;
  },

  // BATCHED channel_id -> channel_name FOR REQUEST ORIGIN COPY
  async _channelNamesFor(requests) {
    const ids = [...new Set(requests.map(request => request.orig_channel_id).filter(Boolean))];
    if (!ids.length) return {};
    const channels = await this.core.models.discordChannel.getMany({ channel_id: { in: ids } });
    return Object.fromEntries(channels.map(channel => [channel.channel_id, channel.channel_name]));
  },

  // ONE REQUESTS PAGE FOR THE SELF APP'S REQUESTS SECTION - SEARCH + FILTER
  // TABS + VIEW-MORE PAGINATION, MIRRORING THE USERS SECTION'S SHAPE
  async getRequestsPage({ page = 1, filter = 'all', search = '' } = {}) {
    const wantFilter = REQUEST_FILTERS[filter] ? filter : 'all';
    const searchWhere = search
      ? {
        OR: [
          { media: { title: { contains: search } } },
          { orig_parsed_title: { contains: search } },
          { users: { some: { OR: [{ username: { contains: search } }, { display_name: { contains: search } }] } } }
        ]
      }
      : {};

    const [raw, ...countValues] = await Promise.all([
      this.core.prisma.mediaRequest.findMany({
        where: { ...searchWhere, ...REQUEST_FILTERS[wantFilter] },
        include: { media: true, users: true, made_in: true, app: true },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * REQUESTS_PAGE_SIZE,
        take: REQUESTS_PAGE_SIZE + 1
      }),
      ...Object.keys(REQUEST_FILTERS).map(key =>
        this.core.prisma.mediaRequest.count({ where: { ...searchWhere, ...REQUEST_FILTERS[key] } })
      )
    ]);
    const counts = Object.fromEntries(Object.keys(REQUEST_FILTERS).map((key, index) => [key, countValues[index]]));

    const requests = raw.slice(0, REQUESTS_PAGE_SIZE);
    const [queueRows, channelNames, msIndexes, config] = await Promise.all([
      this._queueRowsFor(requests, { liveFallback: true }),
      this._channelNamesFor(requests),
      this.mediaServerCacheIndexes(),
      this.core.models.configuration.get()
    ]);

    return {
      rows: requests.map(request => this.buildRequestView(request, queueRows.get(request.id) || null, {
        channelName: channelNames[request.orig_channel_id] || null,
        config,
        msIndexes,
        withStages: true
      })),
      hasMore: raw.length > REQUESTS_PAGE_SIZE,
      page,
      search,
      filter: wantFilter,
      counts
    };
  },

  // FULL CARD VIEW MODELS FOR THE CHAT MIRROR, KEYED BY TRIGGERING MESSAGE ID.
  // ONE REQUEST QUERY + queueCache LOOKUPS - A CHAT RENDER NEVER ISSUES HTTP
  async cardsForMessages(messageIds = []) {
    if (!messageIds.length) return {};
    const requests = await this.core.models.mediaRequest.getMany(
      { orig_message_id: { in: messageIds } },
      { media: true, users: true, made_in: true, app: true }
    );
    if (!requests.length) return {};

    const queueRows = await this._queueRowsFor(requests);
    // THE OVERRIDE SELECT ONLY RENDERS ON PENDING CARDS - SKIP THE LOOKUP
    // WHEN NOTHING ON SCREEN CAN USE IT
    const instanceOptions = requests.some(request => request.status === null)
      ? await this.buildInstanceOptions()
      : {};

    const cards = {};
    for (const request of requests) {
      const card = this.buildRequestView(request, queueRows.get(request.id) || null);
      card.instanceOptions = instanceOptions[card.contentType] || [];
      cards[request.orig_message_id] = card;
    }
    return cards;
  },

  // ONE BROADCAST UPDATES EVERY SURFACE: THE REQUESTS SECTION CARD AND THE
  // CHAT MIRROR'S INLINE CARD RIDE THE SAME FRAME AS ID-KEYED OOB SWAPS -
  // MISSING TARGETS (SECTION CLOSED, MESSAGE OFF-SCREEN) ARE HARMLESS NO-OPS
  async pushRequestCard(requestId, queueRow = null) {
    try {
      const request = await this.core.models.mediaRequest.getWithRelations(requestId);
      if (!request) return;
      const [channelNames, msIndexes, config, instanceOptions] = await Promise.all([
        this._channelNamesFor([request]),
        this.mediaServerCacheIndexes(),
        this.core.models.configuration.get(),
        request.status === null ? this.buildInstanceOptions() : Promise.resolve({})
      ]);
      const req = this.buildRequestView(request, queueRow, {
        channelName: channelNames[request.orig_channel_id] || null,
        config,
        msIndexes,
        withStages: true
      });
      req.instanceOptions = instanceOptions[req.contentType] || [];
      await this.core.sockets.emitCompiled(['apps/sections/requestCardPush.pug'], { req });
    } catch (err) {
      this.logger.warn(`Request card push failed: ${err.message}`);
    }
  },

  // LIBRARY DETAIL -> ORIGIN ROWS: MATCH THE SERVICE ITEM TO A LEDGER ROW BY
  // ITS STRONGEST EXTERNAL ID (PATH AS LAST RESORT), THEN SURFACE EVERY
  // REQUEST ON RECORD. null = NO LEDGER ROW = ADDED OUTSIDE DISCOFLIX.
  async getRequestOrigin(detail) {
    const raw = detail?.raw || {};
    const media = await this.core.models.media.findByResult({
      imdbId: raw.imdbId ? String(raw.imdbId) : null,
      tmdbId: raw.tmdbId ? String(raw.tmdbId) : null,
      tvdbId: raw.tvdbId ? String(raw.tvdbId) : null,
      musicbrainzId: raw.foreignAlbumId || raw.foreignArtistId || null
    }) || (raw.path ? await this.core.models.media.findByExternalId('path', raw.path) : null);
    if (!media) return null;

    const requests = await this.core.models.media.getRequests(media.id);
    if (!requests.length) return null;
    requests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const channelNames = await this._channelNamesFor(requests);

    return {
      mediaId: media.id,
      requests: requests.map(request => {
        // getRequests OMITS THE MEDIA RELATION - stateOf NEEDS is_available
        const view = this.buildRequestView({ ...request, media }, null, {
          channelName: channelNames[request.orig_channel_id] || null
        });
        return view;
      })
    };
  }
};
