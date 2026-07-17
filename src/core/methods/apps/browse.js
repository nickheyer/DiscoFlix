const FEED_PAGE_SIZE = 15;
const FEED_TTL_MS = 60 * 1000;
const LIBRARY_TTL_MS = 5 * 60 * 1000;
const SEARCH_RESULT_CAP = 20;
const RELEASE_RESULT_CAP = 30;
const BROWSE_VIEWS = ['covers', 'detailed'];
const BROWSE_VIEW_DEFAULTS = { library: 'covers', search: 'detailed' };

// READ-ONLY BROWSING SURFACES FOR THE TAKEOVER: THE ACTIVITY FEED (RIGHT RAIL,
// REPLACES THE MEMBERS PANE - AND THE OLD HISTORY SECTION) AND LIBRARY POSTER
// PAGES. BOTH RIDE SMALL CACHES SO SECTION SWITCHES AND REVEALED-SENTINEL
// PAGINATION DON'T HAMMER THE SERVICES.
module.exports = {
  FEED_PAGE_SIZE,

  // TITLE MATCHING FALLBACK FOR IDENTITY ANSWERS - EXTERNAL IDS WIN, THIS
  // ONLY CATCHES ITEMS A SERVICE NEVER GOT AN ID FOR
  comparableTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  },

  // STICKY PER-INSTANCE VIEW STYLE FOR THE LIBRARY SURFACE, KEYED BY MODE
  // (BROWSE DEFAULTS TO COVERS, SEARCH TO DETAILED). IN-MEMORY BY DESIGN -
  // A LAYOUT WHIM, NOT CONFIG - SO IT RESETS TO THE DEFAULTS ON BOOT.
  getBrowseView(appId, mode) {
    return this.browseViews.get(`${appId}:${mode}`) || BROWSE_VIEW_DEFAULTS[mode] || 'covers';
  },

  setBrowseView(appId, mode, view) {
    if (!BROWSE_VIEWS.includes(view)) return;
    this.browseViews.set(`${appId}:${mode}`, view);
  },

  // THE LAST SERVICE-SEARCH TERM PER INSTANCE - LETS DETAIL VIEWS OFFER A
  // BACK-TO-RESULTS BUTTON WITHOUT THREADING THE TERM THROUGH EVERY SWAP.
  // IN-MEMORY BY DESIGN, SAME AS browseViews - A NAVIGATION WHIM, NOT CONFIG.
  rememberSearchTerm(appId, term) {
    this.searchTerms.set(appId, term);
  },

  lastSearchTermOf(appId) {
    return this.searchTerms.get(appId) || '';
  },

  // isImported REACHES INTO SERVICE-SHAPED raw - NEVER LET A SHAPE SURPRISE
  // TAKE A BROWSE RENDER DOWN
  safeIsImported(client, raw) {
    try {
      return !!client.isImported(raw);
    } catch (err) {
      return false;
    }
  },

  rowStateOf(client, result) {
    if (!result.libraryId) return 'addable';
    return this.safeIsImported(client, result.raw) ? 'available' : 'in-library';
  },

  // LIVE LOOKUP AGAINST THE INSTANCE'S SERVICE, EACH ROW TAGGED WITH ITS
  // LIBRARY STATE - THE LIBRARY SECTION'S SEARCH MODE RENDERS THESE
  async getSearchResults(instance, term) {
    const client = this.getClientForInstance(instance);
    if (!client || !client.capabilities.search) {
      return { results: [], error: `${instance.display_name} cannot search` };
    }
    try {
      const results = (await client.search(term))
        .slice(0, SEARCH_RESULT_CAP)
        .map(result => ({ ...result, rowState: this.rowStateOf(client, result) }));
      return { results, error: null };
    } catch (err) {
      this.logger.warn(`${instance.display_name} search failed: ${err.message}`);
      return { results: [], error: err.message };
    }
  },

  // ONE LIVE HISTORY PAGE, GUARDED - FEED FAILURES NEVER TAKE A RENDER DOWN
  async getFeedPage(instance, page = 1) {
    if (instance && instance.app_type === 'discoflix') return this._getSelfFeedPage(page);
    const client = this.getClientForInstance(instance);
    if (!client) return { rows: [], hasMore: false };
    try {
      return await client.getHistory(page, FEED_PAGE_SIZE);
    } catch (err) {
      this.logger.debug(`${instance.display_name} feed fetch failed: ${err.message}`);
      return { rows: [], hasMore: false, error: err.message };
    }
  },

  // THE SELF APP'S FEED IS THE BOT'S OWN LEDGER - RECENT MEDIA REQUESTS,
  // NEWEST FIRST, SAME ROW SHAPE THE CLIENT HISTORIES NORMALIZE TO
  async _getSelfFeedPage(page = 1) {
    try {
      const raw = await this.core.prisma.mediaRequest.findMany({
        include: { media: true, users: true },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * FEED_PAGE_SIZE,
        take: FEED_PAGE_SIZE + 1
      });
      const rows = raw.slice(0, FEED_PAGE_SIZE).map(request => {
        const media = request.media;
        let kind = 'pending';
        if (request.status === false) kind = 'denied';
        else if (request.status === true) kind = media?.is_available ? 'available' : 'approved';
        const requester = request.users?.[0];
        return {
          id: request.id,
          kind,
          title: media?.title
            ? (media.year ? `${media.title} (${media.year})` : media.title)
            : (request.orig_parsed_title || 'Unknown request'),
          detail: requester ? `by ${requester.display_name || requester.username}` : 'from the console',
          at: request.updated_at || request.created_at
        };
      });
      return { rows, hasMore: raw.length > FEED_PAGE_SIZE };
    } catch (err) {
      this.logger.debug(`Self feed fetch failed: ${err.message}`);
      return { rows: [], hasMore: false, error: err.message };
    }
  },

  // PAGE 1, CACHED - TAKEOVER RENDERS AND THE HEARTBEAT SHARE IT
  async getFeedViewModel(instance) {
    if (!instance) return { rows: [], hasMore: false };
    const cached = this.feedCache.get(instance.id);
    if (cached && Date.now() - cached.fetchedAt < FEED_TTL_MS) return cached.feed;
    const feed = await this.getFeedPage(instance, 1);
    this.feedCache.set(instance.id, { feed, fetchedAt: Date.now() });
    return feed;
  },

  // HEARTBEAT REFRESH - RETURNS THE FRESH FEED ONLY WHEN IT ACTUALLY CHANGED,
  // SO THE RAIL ISN'T RE-SWAPPED (AND ITS SCROLL RESET) EVERY 60s
  async refreshFeed(instance) {
    const feedKey = feed => JSON.stringify((feed?.rows || []).map(row => `${row.id}:${row.kind}`));
    const previous = this.feedCache.get(instance.id);
    const feed = await this.getFeedPage(instance, 1);
    this.feedCache.set(instance.id, { feed, fetchedAt: Date.now() });
    return feedKey(feed) !== feedKey(previous?.feed) ? feed : null;
  },

  // THE TTL-CACHED FULL LISTING
  async _getFullLibrary(instance, client) {
    const cached = this.libraryCache.get(instance.id);
    if (cached && Date.now() - cached.fetchedAt < LIBRARY_TTL_MS) return cached.items;

    // COLD CACHE - NOTHING TO SERVE, THE CALLER WAITS FOR THE REAL FETCH
    if (!cached) {
      const items = await client.getLibrary();
      this.libraryCache.set(instance.id, { items, fetchedAt: Date.now() });
      return items;
    }

    if (!cached.refreshing) {
      cached.refreshing = client.getLibrary()
        .then((items) => {
          this.libraryCache.set(instance.id, { items, fetchedAt: Date.now() });
        })
        .catch((err) => {
          this.logger.debug(`${instance.display_name} library refresh failed, keeping stale copy: ${err.message}`);
          cached.refreshing = null;
        });
    }
    return cached.items;
  },

  // CACHE-FIRST LIBRARY COUNTS FOR OVERVIEWS - NEVER BLOCKS A RENDER LONGER
  // THAN timeoutMs. ON A COLD CACHE THE FETCH KEEPS RUNNING TO WARM THE TTL
  // CACHE, AND THE CALLER RENDERS DASHES UNTIL THE NEXT VISIT. RETURNS
  // { total, available, missing, monitored, byKind } OR null.
  async getLibraryCounts(instance, { timeoutMs = 1500 } = {}) {
    const client = this.getClientForInstance(instance);
    if (!client || !client.capabilities.library) return null;

    const countItems = items => {
      const counts = { total: items.length, available: 0, missing: 0, monitored: 0, byKind: {} };
      for (const item of items) {
        if (item.available) counts.available++;
        else counts.missing++;
        if (item.monitored === true) counts.monitored++;
        const kind = item.kind || 'other';
        counts.byKind[kind] = (counts.byKind[kind] || 0) + 1;
      }
      return counts;
    };

    const cached = this.libraryCache.get(instance.id);
    if (cached && Date.now() - cached.fetchedAt < LIBRARY_TTL_MS) return countItems(cached.items);

    const fetch = this._getFullLibrary(instance, client);
    fetch.catch(err => this.logger.debug(`${instance.display_name} library warm-up failed: ${err.message}`));
    const items = await Promise.race([
      fetch,
      new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
    ]).catch(() => null);
    return items ? countItems(items) : null;
  },

  // PER-SERVER LOOKUP INDEXES OVER THE TTL-CACHED LIBRARIES - EXTERNAL-ID
  // MAPS PLUS A TITLE MAP, SO A BATCH OF RESULTS MATCHES IN O(1) EACH.
  // FAILURES SKIP THE SERVER, NEVER THE CALLER.
  async _mediaServerIndexes() {
    const rows = await this.core.models.app.getMany({ enabled: true });
    const servers = rows.filter(row =>
      this.getType(row.app_type)?.kind === 'media-server' && this.isConfigured(row)
    );
    const indexes = [];
    for (const row of servers) {
      const client = this.getClientForInstance(row);
      if (!client || !client.capabilities.library) continue;
      let items;
      try {
        items = await this._getFullLibrary(row, client);
      } catch (err) {
        this.logger.debug(`${row.display_name} availability check skipped: ${err.message}`);
        continue;
      }
      const byId = { tmdb: new Map(), imdb: new Map(), tvdb: new Map() };
      const byTitle = new Map();
      for (const item of items) {
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

  // EXTERNAL IDS MATCH FIRST, TITLE+YEAR CATCHES THE REST
  _matchInIndex(index, result) {
    const wantKind = result.contentType === 'show' ? 'show' : 'movie';
    const wantIds = {
      tmdb: result.tmdbId ? String(result.tmdbId) : null,
      imdb: result.imdbId ? String(result.imdbId) : null,
      tvdb: result.tvdbId ? String(result.tvdbId) : null
    };
    for (const key of ['tmdb', 'imdb', 'tvdb']) {
      const item = wantIds[key] && index.byId[key].get(`${wantKind}:${wantIds[key]}`);
      if (item) return { instance: index.instance, item };
    }
    const wantTitle = this.comparableTitle(result.title);
    if (wantTitle) {
      const item = index.byTitle.get(`${wantKind}:${wantTitle}`);
      if (item && (!result.year || !item.year || item.year === result.year)) {
        return { instance: index.instance, item };
      }
    }
    return null;
  },

  _matchInIndexes(indexes, result) {
    for (const index of indexes) {
      const match = this._matchInIndex(index, result);
      if (match) return match;
    }
    return null;
  },

  // THE BOT'S AVAILABILITY ANSWER: EVERY CONNECTED MEDIA SERVER THIS LOOKUP
  // RESULT IS ALREADY STREAMABLE ON - [{ instance, item }], EMPTY WHEN NONE.
  // ALL SERVERS, NOT THE FIRST: "ALREADY ON PLEX" IS A LIE WHEN IT'S ALSO ON
  // TWO OTHERS. FAILURES NEVER BLOCK A REQUEST FLOW.
  async findOnMediaServers(result) {
    const indexes = await this._mediaServerIndexes();
    return indexes.map(index => this._matchInIndex(index, result)).filter(Boolean);
  },

  // ADVISORY BADGES FOR A BATCH OF LOOKUP RESULTS - ONE { text, servers }
  // (OR null) PER RESULT, ALIGNED BY INDEX; servers LISTS EVERY MEDIA SERVER
  // THE TITLE STREAMS ON ({ appType, name }, EMPTY FOR NON-STREAMING BADGES)
  // SO RENDER SITES CAN BADGE EACH WITH ITS BRAND EMOJI. PRECEDENCE:
  // STREAMABLE > IN LIBRARY > PENDING REQUEST. THE SELECTION-TIME GUARDS
  // STAY AUTHORITATIVE.
  async annotateAvailability(results, client) {
    const badges = new Array(results.length).fill(null);
    // MUSIC NEVER MATCHES A MEDIA SERVER - THEIR NORMALIZERS ONLY EMIT
    // movie/show KINDS, SO SKIP THE LIBRARY FETCHES ENTIRELY
    const indexes = results.some(result => result.contentType !== 'music')
      ? await this._mediaServerIndexes()
      : [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.contentType !== 'music') {
        const streaming = indexes.map(index => this._matchInIndex(index, result)).filter(Boolean);
        if (streaming.length) {
          badges[i] = {
            text: `Available on ${streaming.map(match => match.instance.display_name).join(', ')}`,
            servers: streaming.map(match => ({ appType: match.instance.app_type, name: match.instance.display_name }))
          };
          continue;
        }
      }
      if (result.libraryId) {
        badges[i] = {
          text: this.safeIsImported(client, result.raw) ? 'In library' : 'In library - waiting',
          servers: []
        };
        continue;
      }
      const media = await this.core.models.media.findByResult(result);
      if (media) {
        const open = await this.core.models.mediaRequest.findFirst({ mediaId: media.id, status: null });
        if (open) badges[i] = { text: 'Requested - pending approval', servers: [] };
      }
    }
    return badges;
  },

  // LIVE RELEASE SEARCH FOR INDEXER APPS - THE RELEASES SECTION'S SEARCH MODE
  async getReleaseResults(instance, term) {
    const client = this.getClientForInstance(instance);
    if (!client || !client.capabilities.releases) {
      return { releases: [], error: `${instance.display_name} cannot search releases` };
    }
    try {
      const releases = (await client.searchReleases(term)).slice(0, RELEASE_RESULT_CAP);
      return { releases, error: null };
    } catch (err) {
      this.logger.warn(`${instance.display_name} release search failed: ${err.message}`);
      return { releases: [], error: err.message };
    }
  },

  // NOW PLAYING ROWS - LIVE ON SECTION RENDERS (STREAMS MOVE FASTER THAN THE
  // HEARTBEAT), CACHED SO WS PUSHES AND FALLBACK RENDERS SHARE ONE SHAPE
  async getSessionsFor(instance) {
    const client = this.getClientForInstance(instance);
    if (!client || !client.capabilities.sessions) return { sessions: [], error: null };
    try {
      const sessions = await client.getSessions();
      this.sessionsCache.set(instance.id, sessions);
      return { sessions, error: null };
    } catch (err) {
      this.logger.debug(`${instance.display_name} sessions fetch failed: ${err.message}`);
      return { sessions: this.sessionsCache.get(instance.id) || [], error: err.message };
    }
  },

  // ONE LIVE DETAIL FETCH PER OPEN - NEVER CACHED, THE OPERATOR EXPECTS THE
  // SAME TRUTH THE ARR'S OWN DETAIL PAGE WOULD SHOW
  async getLibraryItemDetail(instance, itemId) {
    const client = this.getClientForInstance(instance);
    if (!client || !client.capabilities.libraryDetail) {
      return { error: `${instance.display_name} has no detail view` };
    }
    try {
      return { detail: await client.getLibraryItemDetail(itemId) };
    } catch (err) {
      this.logger.warn(`${instance.display_name} detail fetch failed: ${err.message}`);
      return { error: err.message };
    }
  }
};
