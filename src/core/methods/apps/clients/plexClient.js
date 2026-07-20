const axios = require('axios');
const BaseClient = require('./baseClient');
const tuning = require('../../../tuning');

// SECTION TYPES THE CONSOLE BROWSES - MUSIC/PHOTO LIBRARIES STAY PLEX-ONLY
const BROWSABLE_TYPES = new Set(['movie', 'show']);

// PLEX MEDIA SERVER - X-Plex-Token AUTH, JSON VIA THE Accept HEADER. NO
// DOWNLOAD QUEUE; THE ACTIVITY FEED IS THE RECENTLY ADDED SHELF. LIBRARY,
// SEARCH, DETAIL, AND NOW PLAYING ALL RENDER IN-CONSOLE; ART IS PROXIED
// THROUGH /apps/:id/image SO THE TOKEN NEVER LANDS IN AN <img> TAG.
class PlexClient extends BaseClient {
  constructor({ url, token, logger, instanceId }) {
    super({ url, logger });
    this.serviceLabel = 'Plex';
    this.instanceId = instanceId || null;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: tuning.value('media_server_http_timeout_seconds') * 1000,
      headers: { 'X-Plex-Token': token, Accept: 'application/json' }
    });
  }

  async _get(path, params = {}) {
    try {
      const { data } = await this.http.get(path, { params });
      return data;
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  // CONSOLE-PROXIED ART URL - PLEX'S PHOTO TRANSCODER KEEPS GRIDS LIGHT
  _proxyImage(plexPath, width, height) {
    if (!plexPath || !this.instanceId) return null;
    const transcode = `/photo/:/transcode?width=${width}&height=${height}&minSize=1&upscale=1&url=${encodeURIComponent(plexPath)}`;
    return `/apps/${this.instanceId}/image?path=${encodeURIComponent(transcode)}`;
  }

  _posterOf(item) {
    return this._proxyImage(item.thumb || item.parentThumb || item.grandparentThumb, 400, 600);
  }

  // GUID ENTRIES ARRIVE AS tmdb://603 STYLE URIS (includeGuids=1)
  static externalIdsFrom(raw) {
    const ids = {};
    for (const guid of raw.Guid || []) {
      const match = String(guid.id || '').match(/^(imdb|tmdb|tvdb):\/\/(.+)$/);
      if (match) ids[match[1]] = match[2];
    }
    return ids;
  }

  // THE SERVER ROOT REQUIRES A VALID TOKEN AND CARRIES THE VERSION - EXACTLY
  // THE CONNECTIVITY PROOF A STATUS CHECK WANTS
  async getStatus() {
    const data = await this._get('/');
    return { version: data?.MediaContainer?.version || null };
  }

  async getQueue() {
    return [];
  }

  // NOW PLAYING - EVERY ACTIVE STREAM AS A NORMALIZED SESSION ROW
  async getSessions() {
    const data = await this._get('/status/sessions');
    return (data?.MediaContainer?.Metadata || []).map(item => {
      const duration = Number(item.duration) || 0;
      const offset = Number(item.viewOffset) || 0;
      const media = (item.Media || [])[0] || {};
      const chips = [
        item.TranscodeSession ? 'Transcode' : 'Direct Play',
        media.videoResolution ? `${media.videoResolution}${/^\d+$/.test(media.videoResolution) ? 'p' : ''}` : null,
        media.bitrate ? `${(media.bitrate / 1000).toFixed(1)} Mbps` : null
      ].filter(Boolean);
      return {
        id: String(item.Session?.id || item.sessionKey || item.ratingKey),
        title: item.grandparentTitle ? `${item.grandparentTitle} - ${item.title}` : (item.title || 'Unknown'),
        subtitle: item.type === 'episode' && item.parentIndex != null
          ? `S${item.parentIndex}E${item.index}`
          : (item.year ? String(item.year) : null),
        user: item.User?.title || 'Unknown',
        device: [item.Player?.product, item.Player?.title].filter(Boolean).join(' - ') || null,
        state: item.Player?.state === 'paused' ? 'paused' : (item.Player?.state === 'buffering' ? 'buffering' : 'playing'),
        percent: duration ? BaseClient.clampPercent((offset / duration) * 100) : 0,
        chips,
        raw: item
      };
    });
  }

  // EVERY MOVIE/SHOW ACROSS EVERY BROWSABLE SECTION - ONE-SHOT LISTING FOR
  // THE TTL LIBRARY CACHE, GUIDS INCLUDED SO THE BOT CAN ANSWER AVAILABILITY
  async getLibrary() {
    const sections = await this._get('/library/sections');
    const browsable = (sections?.MediaContainer?.Directory || [])
      .filter(section => BROWSABLE_TYPES.has(section.type));
    const items = [];
    for (const section of browsable) {
      const data = await this._get(`/library/sections/${section.key}/all`, { includeGuids: 1 });
      for (const raw of data?.MediaContainer?.Metadata || []) {
        items.push(this.normalizeLibraryItem(raw));
      }
    }
    return items.sort((a, b) => (a.sortTitle || a.title || '').localeCompare(b.sortTitle || b.title || ''));
  }

  normalizeLibraryItem(raw) {
    return {
      id: String(raw.ratingKey),
      title: raw.title,
      sortTitle: raw.titleSort || raw.title,
      year: raw.year || null,
      overview: raw.summary || '',
      posterUrl: this._posterOf(raw),
      available: true,
      kind: raw.type === 'show' ? 'show' : 'movie',
      // SHOW LISTINGS CARRY THE COUNTS FOR FREE - childCount/leafCount
      seasonCount: raw.type === 'show' ? (Number(raw.childCount) || null) : null,
      episodeCount: raw.type === 'show' ? (Number(raw.leafCount) || null) : null,
      externalIds: PlexClient.externalIdsFrom(raw)
    };
  }

  // LIBRARY SEARCH VIA THE HUBS ENDPOINT - RESULTS ARE ALWAYS IN THE LIBRARY,
  // SO EVERY ROW CARRIES ITS libraryId AND RENDERS AS AVAILABLE
  async search(term) {
    const data = await this._get('/hubs/search', { query: term, limit: 10, includeGuids: 1 });
    const results = [];
    for (const hub of data?.MediaContainer?.Hub || []) {
      if (!BROWSABLE_TYPES.has(hub.type)) continue;
      for (const raw of hub.Metadata || []) {
        results.push(this.normalizeResult(raw));
      }
    }
    return results;
  }

  normalizeResult(raw) {
    return {
      appType: 'plex',
      contentType: raw.type === 'show' ? 'show' : 'movie',
      title: raw.title,
      year: raw.year || null,
      overview: raw.summary || '',
      posterUrl: this._posterOf(raw),
      externalKey: String(raw.ratingKey),
      libraryId: String(raw.ratingKey),
      raw
    };
  }

  isImported() {
    return true; // ON A MEDIA SERVER, IN THE LIBRARY MEANS STREAMABLE
  }

  async getLibraryItemDetail(ratingKey) {
    const data = await this._get(`/library/metadata/${ratingKey}`, { includeGuids: 1 });
    const raw = (data?.MediaContainer?.Metadata || [])[0];
    if (!raw) throw new Error(`${this.serviceLabel} has no item ${ratingKey}`);

    let seasons = null;
    if (raw.type === 'show') {
      const children = await this._get(`/library/metadata/${ratingKey}/children`);
      seasons = (children?.MediaContainer?.Metadata || [])
        .filter(child => child.type === 'season')
        .map(child => {
          const total = Number(child.leafCount) || 0;
          const viewed = Number(child.viewedLeafCount) || 0;
          return {
            label: child.title,
            monitored: true,
            percent: total ? BaseClient.clampPercent((viewed / total) * 100) : 0,
            episodeFileCount: viewed,
            totalEpisodeCount: total,
            size: null
          };
        });
    }
    return this.normalizeDetail(raw, seasons);
  }

  normalizeDetail(raw, seasons) {
    const contentKind = raw.type === 'show' ? 'show' : 'movie';
    const externalIds = PlexClient.externalIdsFrom(raw);
    const media = (raw.Media || [])[0] || {};
    const part = (media.Part || [])[0] || {};
    const ratings = [];
    if (typeof raw.rating === 'number') ratings.push({ label: 'Critics', value: raw.rating.toFixed(1), votes: null });
    if (typeof raw.audienceRating === 'number') ratings.push({ label: 'Audience', value: raw.audienceRating.toFixed(1), votes: null });

    return {
      id: String(raw.ratingKey),
      contentKind,
      title: raw.title,
      year: raw.year || null,
      overview: raw.summary || '',
      posterUrl: this._posterOf(raw),
      fanartUrl: this._proxyImage(raw.art, 1280, 720),
      monitored: null, // NO MONITORING CONCEPT - THE DETAIL CHIP AND VERB STAY HIDDEN
      available: true,
      availabilityLabel: `On ${this.serviceLabel}`,
      verbs: [],
      genres: (raw.Genre || []).map(genre => genre.tag),
      runtime: BaseClient.formatRuntime(raw.duration ? Math.round(raw.duration / 60000) : null),
      certification: raw.contentRating || null,
      ratings,
      links: [
        externalIds.imdb && { label: 'IMDb', url: `https://www.imdb.com/title/${externalIds.imdb}` },
        externalIds.tmdb && { label: 'TMDB', url: `https://www.themoviedb.org/${contentKind === 'show' ? 'tv' : 'movie'}/${externalIds.tmdb}` },
        contentKind === 'show' && externalIds.tvdb && { label: 'TVDB', url: `https://www.thetvdb.com/dereferrer/series/${externalIds.tvdb}` }
      ].filter(Boolean),
      facts: [
        { label: 'Library', value: raw.librarySectionTitle || null },
        { label: 'Studio', value: raw.studio || null },
        { label: 'Plays', value: raw.viewCount ? String(raw.viewCount) : null },
        { label: 'Last Played', value: raw.lastViewedAt ? BaseClient.formatDate(raw.lastViewedAt * 1000) : null },
        { label: 'Added', value: raw.addedAt ? BaseClient.formatDate(raw.addedAt * 1000) : null },
        { label: 'Episodes', value: contentKind === 'show' && raw.leafCount ? String(raw.leafCount) : null }
      ].filter(fact => fact.value),
      file: contentKind === 'movie' && raw.Media ? {
        quality: media.videoProfile ? media.videoProfile.toUpperCase() : null,
        size: BaseClient.humanSize(part.size),
        resolution: media.videoResolution ? `${media.videoResolution}${/^\d+$/.test(media.videoResolution) ? 'p' : ''}` : null,
        videoCodec: media.videoCodec || null,
        audioCodec: media.audioCodec || null,
        audioChannels: media.audioChannels || null,
        dynamicRange: null,
        languages: null,
        releaseGroup: null,
        relativePath: part.file || null,
        added: raw.addedAt ? BaseClient.formatDate(raw.addedAt * 1000) : null
      } : null,
      seasonsLabel: 'Seasons - watched',
      seasons,
      raw
    };
  }

  // PROXIED ART FETCH - ONLY LIBRARY/TRANSCODER PATHS, TOKEN RIDES THE HEADER
  async fetchImage(path) {
    if (!/^\/(photo|library)\//.test(path)) {
      throw new Error(`${this.serviceLabel} will not proxy that path`);
    }
    try {
      const res = await this.http.get(path, { responseType: 'arraybuffer', headers: { Accept: '*/*' } });
      return { buffer: Buffer.from(res.data), contentType: res.headers['content-type'] || 'image/jpeg' };
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  // NORMALIZED FEED ROWS - PLEX PAGES VIA THE CONTAINER START/SIZE PARAMS.
  // TV ADDITIONS ARRIVE AS SEASON ITEMS WHOSE OWN title IS "Season N" - THE
  // SHOW NAME RIDES parentTitle (SEASONS) OR grandparentTitle (EPISODES)
  async getHistory(page = 1, pageSize = 15) {
    const start = (page - 1) * pageSize;
    const data = await this._get('/library/recentlyAdded', {
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': pageSize,
      includeGuids: 1
    });
    const container = data?.MediaContainer || {};
    const items = container.Metadata || [];
    const total = container.totalSize ?? (start + items.length);
    return {
      rows: items.map(item => this._historyRowOf(item)),
      hasMore: start + items.length < total
    };
  }

  // SERVICE-RELATIVE POSTER PATH FOR FEED ROWS - fetchImage PROXIES IT, THE
  // PHOTO TRANSCODER KEEPS THE BYTES LIGHT. EPISODES PREFER THE SHOW POSTER;
  // A STILL FRAME MAKES A LOUSY THUMBNAIL.
  _historyArtOf(item) {
    const thumb = item.type === 'episode'
      ? (item.grandparentThumb || item.parentThumb || item.thumb)
      : (item.thumb || item.parentThumb || null);
    if (!thumb) return null;
    return `/photo/:/transcode?width=300&height=450&minSize=1&upscale=1&url=${encodeURIComponent(thumb)}`;
  }

  _historyRowOf(item) {
    const base = {
      id: String(item.ratingKey || item.key),
      kind: 'added',
      at: item.addedAt ? new Date(item.addedAt * 1000).toISOString() : null,
      art: this._historyArtOf(item)
    };
    const typeLabel = item.type ? item.type.charAt(0).toUpperCase() + item.type.slice(1) : null;
    const externalIds = PlexClient.externalIdsFrom(item);
    if (item.type === 'episode') {
      const code = BaseClient.seasonEpisodeCode(item.parentIndex, item.index);
      return {
        ...base,
        title: `${item.grandparentTitle || 'Unknown'} - ${item.title || code || 'Unknown'}`,
        detail: [typeLabel, code, item.year || null].filter(Boolean).join(' • ') || null,
        media: {
          kind: 'show',
          title: item.grandparentTitle || item.title,
          year: null,
          season: item.parentIndex ?? null,
          episode: item.index ?? null,
          externalIds
        }
      };
    }
    if (item.type === 'season') {
      const episodes = Number(item.leafCount) || null;
      return {
        ...base,
        title: `${item.parentTitle || 'Unknown'} - ${item.title || `Season ${item.index}`}`,
        detail: [typeLabel, episodes ? `${episodes} episode${episodes === 1 ? '' : 's'}` : null].filter(Boolean).join(' • ') || null,
        media: {
          kind: 'show',
          title: item.parentTitle || item.title,
          year: null,
          season: item.index ?? null,
          episode: null,
          episodeCount: episodes,
          externalIds
        }
      };
    }
    if (item.type === 'album') {
      return {
        ...base,
        title: item.parentTitle ? `${item.parentTitle} - ${item.title}` : (item.title || 'Unknown'),
        detail: [typeLabel, item.year || null].filter(Boolean).join(' • ') || null,
        media: {
          kind: 'music',
          title: item.parentTitle ? `${item.parentTitle} - ${item.title}` : item.title,
          year: item.year || null,
          externalIds
        }
      };
    }
    return {
      ...base,
      title: item.title || 'Unknown',
      detail: [typeLabel, item.year || null].filter(Boolean).join(' • ') || null,
      media: {
        kind: item.type === 'show' ? 'show' : 'movie',
        title: item.title,
        year: item.type === 'show' ? null : (item.year || null),
        externalIds
      }
    };
  }

  get capabilities() {
    return {
      ...super.capabilities,
      search: true,
      library: true,
      libraryDetail: true,
      sessions: true
    };
  }
}

module.exports = PlexClient;
