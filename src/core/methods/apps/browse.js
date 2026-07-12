const FEED_PAGE_SIZE = 15;
const FEED_TTL_MS = 60 * 1000;
const LIBRARY_PAGE_SIZE = 60;
const LIBRARY_TTL_MS = 5 * 60 * 1000;

// READ-ONLY BROWSING SURFACES FOR THE TAKEOVER: THE ACTIVITY FEED (RIGHT RAIL,
// REPLACES THE MEMBERS PANE - AND THE OLD HISTORY SECTION) AND LIBRARY POSTER
// PAGES. BOTH RIDE SMALL CACHES SO SECTION SWITCHES AND REVEALED-SENTINEL
// PAGINATION DON'T HAMMER THE SERVICES.
module.exports = {
  FEED_PAGE_SIZE,
  LIBRARY_PAGE_SIZE,

  // ONE LIVE HISTORY PAGE, GUARDED - FEED FAILURES NEVER TAKE A RENDER DOWN
  async getFeedPage(instance, page = 1) {
    const client = this.getClientForInstance(instance);
    if (!client) return { rows: [], hasMore: false };
    try {
      return await client.getHistory(page, FEED_PAGE_SIZE);
    } catch (err) {
      this.logger.debug(`${instance.display_name} feed fetch failed: ${err.message}`);
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
  }
};
