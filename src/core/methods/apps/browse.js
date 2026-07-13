const FEED_PAGE_SIZE = 15;
const FEED_TTL_MS = 60 * 1000;
const LIBRARY_PAGE_SIZE = 60;
const LIBRARY_TTL_MS = 5 * 60 * 1000;
const SEARCH_RESULT_CAP = 20;
const BROWSE_VIEWS = ['covers', 'detailed'];
const BROWSE_VIEW_DEFAULTS = { library: 'covers', search: 'detailed' };

// READ-ONLY BROWSING SURFACES FOR THE TAKEOVER: THE ACTIVITY FEED (RIGHT RAIL,
// REPLACES THE MEMBERS PANE - AND THE OLD HISTORY SECTION) AND LIBRARY POSTER
// PAGES. BOTH RIDE SMALL CACHES SO SECTION SWITCHES AND REVEALED-SENTINEL
// PAGINATION DON'T HAMMER THE SERVICES.
module.exports = {
  FEED_PAGE_SIZE,
  LIBRARY_PAGE_SIZE,

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

  // LIBRARY PAGES SLICE A TTL-CACHED FULL LISTING - THE ARR RETURNS THE WHOLE
  // LIBRARY IN ONE CALL, AND SCROLL PAGINATION MUST NOT REFETCH IT PER PAGE.
  // THE CACHE IS INVALIDATED ON CONSOLE ADDS (SEARCH & ADD).
  async getLibraryPage(instance, page = 1) {
    const client = this.getClientForInstance(instance);
    if (!client || !client.capabilities.library) {
      return { items: [], total: 0, hasMore: false, page };
    }

    let cached = this.libraryCache.get(instance.id);
    if (!cached || Date.now() - cached.fetchedAt > LIBRARY_TTL_MS) {
      try {
        cached = { items: await client.getLibrary(), fetchedAt: Date.now() };
        this.libraryCache.set(instance.id, cached);
      } catch (err) {
        this.logger.debug(`${instance.display_name} library fetch failed: ${err.message}`);
        return { items: [], total: 0, hasMore: false, page, error: err.message };
      }
    }

    const start = (page - 1) * LIBRARY_PAGE_SIZE;
    const items = cached.items.slice(start, start + LIBRARY_PAGE_SIZE);
    return {
      items,
      total: cached.items.length,
      hasMore: start + items.length < cached.items.length,
      page
    };
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
