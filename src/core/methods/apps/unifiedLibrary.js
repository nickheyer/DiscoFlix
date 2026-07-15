const UNIFIED_PAGE_SIZE = 60;
const UNIFIED_KINDS = ['movie', 'show', 'music'];

// THE UNIFIED MEDIA LIBRARY - EVERY SERVING INSTANCE'S LISTING MERGED INTO
// COMMON MEDIA ITEMS. IDENTITY IS EXTERNAL IDS FIRST (tmdb/imdb/tvdb), THEN
// FILESYSTEM PATH, THEN TITLE+YEAR; THE Media LEDGER JOINS IN BY THE SAME
// KEYS (BACKED BY ITS INDEXES) SO REQUEST HISTORY RIDES EVERY MERGED ITEM.
module.exports = {
  UNIFIED_PAGE_SIZE,

  // MERGE KEYS FOR ONE SERVICE ITEM - tmdb/tvdb NUMBERING COLLIDES ACROSS
  // KINDS SO THOSE SCOPE BY KIND; imdb IDS AND PATHS ARE GLOBALLY UNIQUE
  unifiedKeysOf({ kind, externalIds = {}, path = null, title = null, year = null }) {
    const itemKind = UNIFIED_KINDS.includes(kind) ? kind : 'movie';
    const keys = [];
    if (externalIds.imdb) keys.push(`imdb:${externalIds.imdb}`);
    if (externalIds.tmdb) keys.push(`${itemKind}:tmdb:${externalIds.tmdb}`);
    if (externalIds.tvdb) keys.push(`${itemKind}:tvdb:${externalIds.tvdb}`);
    if (externalIds.musicbrainz) keys.push(`mb:${externalIds.musicbrainz}`);
    if (path) keys.push(`path:${String(path).replace(/[\\/]+$/, '')}`);
    const comparable = this.comparableTitle(title);
    if (comparable) keys.push(`${itemKind}:title:${comparable}:${year || ''}`);
    return keys;
  },

  // POSTER PREFERENCE: CONSOLE-PROXIED SERVICE ART ALWAYS LOADS, THE LOCAL
  // POSTER CACHE IS NEXT, A SERVICE-HOST URL IS THE LAN-ONLY LAST RESORT
  _posterRank(url) {
    if (!url) return 0;
    if (url.startsWith('/apps/')) return 3;
    if (!/^https?:\/\//.test(url)) return 2;
    return 1;
  },

  _adoptPoster(entry, url) {
    if (this._posterRank(url) > this._posterRank(entry.posterUrl)) entry.posterUrl = url;
  },

  // SHOW COUNTS MERGE ON max() - SERVICES DISAGREE ONLY BY WHAT THEY HOLD,
  // SO THE BIGGEST FIGURE IS THE CLOSEST TO THE REAL SERIES
  _adoptCounts(entry, item) {
    for (const field of ['seasonCount', 'episodeCount', 'episodeFileCount']) {
      const value = Number(item[field]);
      if (!isNaN(value) && value > (Number(entry[field]) || 0)) entry[field] = value;
    }
  },

  // FOLD other INTO target WHEN A LATE KEY PROVES TWO ENTRIES ARE ONE ITEM
  _absorbEntry(keyed, target, other) {
    if (target === other) return target;
    target.sources.push(...other.sources);
    this._adoptPoster(target, other.posterUrl);
    this._adoptCounts(target, other);
    if (!target.year && other.year) target.year = other.year;
    if (!target.overview && other.overview) target.overview = other.overview;
    for (const key of other.keys) {
      target.keys.add(key);
      keyed.set(key, target);
    }
    return target;
  },

  // EVERY ENABLED + CONFIGURED LIBRARY-CAPABLE INSTANCE, RAIL ORDER - THE
  // MERGE WALKS THESE SO SOURCE LISTS COME OUT IN A STABLE, FAMILIAR ORDER
  async _unifiedSourceInstances() {
    const rows = await this.core.models.app.getMany(
      { enabled: true },
      {},
      [{ sort_position: 'asc' }, { created_at: 'asc' }]
    );
    return rows.filter(row => {
      const manifest = this.getType(row.app_type);
      if (!manifest || manifest.hidden) return false;
      const client = this.getClientForInstance(row);
      return !!(client && client.capabilities.library);
    });
  },

  // THE MERGED LISTING + PER-SERVICE ERRORS. RIDES THE PER-INSTANCE LIBRARY
  // TTL CACHES, SO REBUILDING PER RENDER COSTS ONE PASS OVER CACHED ITEMS.
  async getUnifiedLibrary() {
    const instances = await this._unifiedSourceInstances();
    const keyed = new Map();
    const entrySet = new Set();
    const errors = [];

    for (const row of instances) {
      const manifest = this.getType(row.app_type);
      const client = this.getClientForInstance(row);
      let items;
      try {
        items = await this._getFullLibrary(row, client);
      } catch (err) {
        this.logger.debug(`${row.display_name} unified listing skipped: ${err.message}`);
        errors.push({ appId: row.id, message: `${row.display_name} didn't answer` });
        continue;
      }

      for (const item of items) {
        const kind = UNIFIED_KINDS.includes(item.kind) ? item.kind : 'movie';
        const keys = this.unifiedKeysOf({ ...item, kind });
        const hits = [...new Set(keys.map(key => keyed.get(key)).filter(Boolean))];
        let entry = hits[0];
        if (!entry) {
          entry = {
            key: keys[0],
            kind,
            title: item.title,
            sortTitle: item.sortTitle || item.title,
            year: item.year || null,
            overview: item.overview || '',
            posterUrl: null,
            seasonCount: null,
            episodeCount: null,
            episodeFileCount: null,
            sources: [],
            keys: new Set(),
            media: null
          };
          entrySet.add(entry);
        }
        for (const extra of hits.slice(1)) {
          this._absorbEntry(keyed, entry, extra);
          entrySet.delete(extra);
        }

        entry.sources.push({
          appId: row.id,
          appType: row.app_type,
          serviceKind: manifest.kind,
          label: row.display_name,
          icon: manifest.icon || null,
          itemId: item.id,
          available: !!item.available
        });
        this._adoptPoster(entry, item.posterUrl);
        this._adoptCounts(entry, item);
        if (!entry.year && item.year) entry.year = item.year;
        if (!entry.overview && item.overview) entry.overview = item.overview;
        for (const key of keys) {
          entry.keys.add(key);
          keyed.set(key, entry);
        }
      }
    }

    // LEDGER JOIN - REQUEST HISTORY AND CACHED POSTERS LAND ON MERGED ITEMS
    const ledger = await this.core.models.media.getLinkLedger();
    for (const rowMedia of ledger) {
      const ledgerKind = rowMedia.tvdb_id ? 'show' : 'movie';
      const keys = this.unifiedKeysOf({
        kind: ledgerKind,
        externalIds: { imdb: rowMedia.imdb_id, tmdb: rowMedia.tmdb_id, tvdb: rowMedia.tvdb_id },
        path: rowMedia.path,
        title: rowMedia.title,
        year: rowMedia.year
      });
      const entry = keys.map(key => keyed.get(key)).find(Boolean);
      if (!entry) continue;
      entry.media = {
        id: rowMedia.id,
        requested: rowMedia.requests.some(request => request.status === null)
      };
      if (rowMedia.poster_url && !/^https?:\/\//.test(rowMedia.poster_url)) {
        this._adoptPoster(entry, `/${String(rowMedia.poster_url).replace(/^\/+/, '')}`);
      }
    }

    const entries = [...entrySet].map(entry => {
      // CONTENT MANAGERS LEAD - THEIR DETAIL VIEW CARRIES THE ACTION VERBS
      entry.sources.sort((a, b) =>
        (a.serviceKind === 'content-manager' ? 0 : 1) - (b.serviceKind === 'content-manager' ? 0 : 1)
      );
      const { keys, ...viewModel } = entry;
      return {
        ...viewModel,
        primary: entry.sources[0],
        streamable: entry.sources.some(source => source.serviceKind === 'media-server'),
        onDisk: entry.sources.some(source => source.available)
      };
    });
    entries.sort((a, b) => (a.sortTitle || a.title || '').localeCompare(b.sortTitle || b.title || ''));
    return { entries, errors };
  },

  // ONE FILTERED PAGE FOR THE BROWSER - COUNTS FOLLOW THE TERM SO THE KIND
  // TABS ALWAYS DESCRIBE WHAT THE CURRENT FILTER WOULD SHOW. scopeAppId
  // NARROWS THE SAME MERGED LIBRARY TO ONE INSTANCE'S HOLDINGS - EVERY APP
  // TAKEOVER IS A FILTERED VIEW OF THE ONE COMPONENT, NEVER ITS OWN DESIGN.
  async getUnifiedPage({ page = 1, kind = 'all', term = '', scopeAppId = null } = {}) {
    const { entries, errors } = await this.getUnifiedLibrary();

    // SCOPED ENTRIES LEAD WITH THEIR SCOPE SOURCE - THE CARD CLICK MUST OPEN
    // THIS INSTANCE'S DETAIL, CROSS-SERVICE CHIPS STAY FOR CONTEXT
    const scoped = scopeAppId
      ? entries
        .filter(entry => entry.sources.some(source => source.appId === scopeAppId))
        .map(entry => ({ ...entry, primary: entry.sources.find(source => source.appId === scopeAppId) }))
      : entries;
    const scopedErrors = scopeAppId
      ? errors.filter(error => error.appId === scopeAppId)
      : errors;

    // TAB PRESENCE IGNORES THE TERM - TABS MUST NOT FLAP WHILE TYPING
    const presentKinds = UNIFIED_KINDS.filter(wanted => scoped.some(entry => entry.kind === wanted));

    const cleanTerm = this.comparableTitle(term);
    const searched = cleanTerm
      ? scoped.filter(entry => this.comparableTitle(entry.title).includes(cleanTerm))
      : scoped;
    const counts = {
      all: searched.length,
      movie: searched.filter(entry => entry.kind === 'movie').length,
      show: searched.filter(entry => entry.kind === 'show').length,
      music: searched.filter(entry => entry.kind === 'music').length
    };
    const wantKind = UNIFIED_KINDS.includes(kind) ? kind : 'all';
    const filtered = wantKind === 'all' ? searched : searched.filter(entry => entry.kind === wantKind);
    const start = (Math.max(1, page) - 1) * UNIFIED_PAGE_SIZE;
    const items = filtered.slice(start, start + UNIFIED_PAGE_SIZE);
    return {
      items,
      total: filtered.length,
      hasMore: start + items.length < filtered.length,
      page: Math.max(1, page),
      counts,
      presentKinds,
      errors: scopedErrors,
      kind: wantKind,
      term: String(term || '').trim(),
      scopeAppId
    };
  }
};
