const axios = require('axios');
const BaseClient = require('./baseClient');
const tuning = require('../../../tuning');

const DETAIL_FIELDS = 'Overview,Genres,MediaSources,ProviderIds,DateCreated,ProductionYear,OfficialRating,CommunityRating,CriticRating,RunTimeTicks,Studios,Path,RecursiveItemCount';
const TICKS_PER_MS = 10000;

// EMBY (AND JELLYFIN, WHICH KEPT THE API SHAPE) - X-Emby-Token AUTH,
// /System/Info FOR STATUS, LATEST ITEMS AS THE ACTIVITY FEED. NO QUEUE.
// LIBRARY, SEARCH, DETAIL, AND NOW PLAYING RENDER IN-CONSOLE; ART IS PROXIED
// THROUGH /apps/:id/image SO THE API KEY NEVER LANDS IN AN <img> TAG.
class EmbyClient extends BaseClient {
  constructor({ url, apiKey, logger, instanceId }) {
    super({ url, logger });
    this.serviceLabel = 'Emby';
    this.instanceId = instanceId || null;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: tuning.value('media_server_http_timeout_seconds') * 1000,
      headers: { 'X-Emby-Token': apiKey }
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

  _proxyImage(itemId, imageType, maxWidth) {
    if (!itemId || !this.instanceId) return null;
    const imagePath = `/Items/${itemId}/Images/${imageType}?maxWidth=${maxWidth}&quality=90`;
    return `/apps/${this.instanceId}/image?path=${encodeURIComponent(imagePath)}`;
  }

  _posterOf(item) {
    if (item.ImageTags?.Primary) return this._proxyImage(item.Id, 'Primary', 400);
    if (item.SeriesPrimaryImageTag) return this._proxyImage(item.SeriesId, 'Primary', 400);
    return null;
  }

  static externalIdsFrom(item) {
    const provider = item.ProviderIds || {};
    const ids = {};
    for (const [key, value] of Object.entries(provider)) {
      const lower = key.toLowerCase();
      if (['tmdb', 'imdb', 'tvdb'].includes(lower) && value) ids[lower] = String(value);
    }
    return ids;
  }

  async getStatus() {
    const info = await this._get('/System/Info');
    return { version: info?.Version || null };
  }

  async getQueue() {
    return [];
  }

  // NOW PLAYING - IDLE SESSIONS (NO NowPlayingItem) DROP OUT
  async getSessions() {
    const sessions = await this._get('/Sessions');
    return (sessions || [])
      .filter(session => session.NowPlayingItem)
      .map(session => {
        const item = session.NowPlayingItem;
        const play = session.PlayState || {};
        const duration = Number(item.RunTimeTicks) || 0;
        const position = Number(play.PositionTicks) || 0;
        const chips = [
          play.PlayMethod === 'Transcode' ? 'Transcode' : 'Direct Play',
          session.TranscodingInfo?.Bitrate ? `${(session.TranscodingInfo.Bitrate / 1000000).toFixed(1)} Mbps` : null
        ].filter(Boolean);
        return {
          id: String(session.Id),
          title: item.SeriesName ? `${item.SeriesName} - ${item.Name}` : (item.Name || 'Unknown'),
          subtitle: item.ParentIndexNumber != null
            ? `S${item.ParentIndexNumber}E${item.IndexNumber ?? '?'}`
            : (item.ProductionYear ? String(item.ProductionYear) : null),
          user: session.UserName || 'Unknown',
          device: [session.Client, session.DeviceName].filter(Boolean).join(' - ') || null,
          state: play.IsPaused ? 'paused' : 'playing',
          percent: duration ? BaseClient.clampPercent((position / duration) * 100) : 0,
          chips,
          raw: session
        };
      });
  }

  // EVERY MOVIE/SERIES IN ONE RECURSIVE LISTING FOR THE TTL LIBRARY CACHE,
  // PROVIDER IDS INCLUDED SO THE BOT CAN ANSWER AVAILABILITY
  async getLibrary() {
    const data = await this._get('/Items', {
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: 'Overview,ProviderIds,ProductionYear,SortName,Path,ChildCount,RecursiveItemCount'
    });
    return (data?.Items || []).map(item => this.normalizeLibraryItem(item));
  }

  normalizeLibraryItem(item) {
    const isShow = item.Type === 'Series';
    return {
      id: String(item.Id),
      title: item.Name,
      sortTitle: item.SortName || item.Name,
      year: item.ProductionYear || null,
      overview: item.Overview || '',
      posterUrl: this._posterOf(item),
      available: true,
      kind: isShow ? 'show' : 'movie',
      // SERIES LISTINGS CARRY THE COUNTS - ChildCount/RecursiveItemCount
      seasonCount: isShow ? (Number(item.ChildCount) || null) : null,
      episodeCount: isShow ? (Number(item.RecursiveItemCount) || null) : null,
      path: item.Path || null,
      externalIds: EmbyClient.externalIdsFrom(item)
    };
  }

  // LIBRARY SEARCH - RESULTS ARE ALWAYS IN THE LIBRARY, SO EVERY ROW CARRIES
  // ITS libraryId AND RENDERS AS AVAILABLE
  async search(term) {
    const data = await this._get('/Items', {
      SearchTerm: term,
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      Limit: 20,
      Fields: 'Overview,ProviderIds,ProductionYear'
    });
    return (data?.Items || []).map(item => this.normalizeResult(item));
  }

  normalizeResult(item) {
    return {
      appType: this.serviceLabel.toLowerCase(), // JELLYFIN INHERITS THIS PATH
      contentType: item.Type === 'Series' ? 'show' : 'movie',
      title: item.Name,
      year: item.ProductionYear || null,
      overview: item.Overview || '',
      posterUrl: this._posterOf(item),
      externalKey: String(item.Id),
      libraryId: String(item.Id),
      raw: item
    };
  }

  isImported() {
    return true; // ON A MEDIA SERVER, IN THE LIBRARY MEANS STREAMABLE
  }

  async getLibraryItemDetail(itemId) {
    const data = await this._get('/Items', { Ids: itemId, Fields: DETAIL_FIELDS });
    const raw = (data?.Items || [])[0];
    if (!raw) throw new Error(`${this.serviceLabel} has no item ${itemId}`);

    let seasons = null;
    if (raw.Type === 'Series') {
      const children = await this._get('/Items', {
        ParentId: raw.Id,
        IncludeItemTypes: 'Season',
        Fields: 'RecursiveItemCount',
        SortBy: 'IndexNumber'
      });
      seasons = (children?.Items || []).map(season => {
        const episodes = Number(season.RecursiveItemCount) || 0;
        return {
          label: season.Name,
          monitored: true,
          percent: 100,
          episodeFileCount: episodes,
          totalEpisodeCount: episodes,
          size: null
        };
      });
    }
    return this.normalizeDetail(raw, seasons);
  }

  normalizeDetail(raw, seasons) {
    const contentKind = raw.Type === 'Series' ? 'show' : 'movie';
    const externalIds = EmbyClient.externalIdsFrom(raw);
    const source = (raw.MediaSources || [])[0] || {};
    const streams = source.MediaStreams || [];
    const video = streams.find(stream => stream.Type === 'Video') || {};
    const audio = streams.find(stream => stream.Type === 'Audio') || {};
    const ratings = [];
    if (typeof raw.CommunityRating === 'number') ratings.push({ label: 'Community', value: raw.CommunityRating.toFixed(1), votes: null });
    if (typeof raw.CriticRating === 'number') ratings.push({ label: 'Critics', value: `${Math.round(raw.CriticRating)}%`, votes: null });

    return {
      id: String(raw.Id),
      contentKind,
      title: raw.Name,
      year: raw.ProductionYear || null,
      overview: raw.Overview || '',
      posterUrl: this._posterOf(raw),
      fanartUrl: (raw.BackdropImageTags || []).length ? this._proxyImage(raw.Id, 'Backdrop', 1280) : null,
      monitored: null, // NO MONITORING CONCEPT - THE DETAIL CHIP AND VERB STAY HIDDEN
      available: true,
      availabilityLabel: `On ${this.serviceLabel}`,
      verbs: [],
      genres: raw.Genres || [],
      runtime: BaseClient.formatRuntime(raw.RunTimeTicks ? Math.round(raw.RunTimeTicks / TICKS_PER_MS / 60000) : null),
      certification: raw.OfficialRating || null,
      ratings,
      links: [
        externalIds.imdb && { label: 'IMDb', url: `https://www.imdb.com/title/${externalIds.imdb}` },
        externalIds.tmdb && { label: 'TMDB', url: `https://www.themoviedb.org/${contentKind === 'show' ? 'tv' : 'movie'}/${externalIds.tmdb}` },
        contentKind === 'show' && externalIds.tvdb && { label: 'TVDB', url: `https://www.thetvdb.com/dereferrer/series/${externalIds.tvdb}` }
      ].filter(Boolean),
      facts: [
        { label: 'Studio', value: (raw.Studios || [])[0]?.Name || null },
        { label: 'Container', value: source.Container ? source.Container.toUpperCase() : null },
        { label: 'Path', value: raw.Path || null },
        { label: 'Added', value: BaseClient.formatDate(raw.DateCreated) },
        { label: 'Episodes', value: contentKind === 'show' && raw.RecursiveItemCount ? String(raw.RecursiveItemCount) : null }
      ].filter(fact => fact.value),
      file: contentKind === 'movie' && raw.MediaSources?.length ? {
        quality: null,
        size: BaseClient.humanSize(source.Size),
        resolution: video.Height ? `${video.Height}p` : null,
        videoCodec: video.Codec || null,
        audioCodec: audio.Codec || null,
        audioChannels: audio.Channels || null,
        dynamicRange: video.VideoRange && video.VideoRange !== 'SDR' ? video.VideoRange : null,
        languages: audio.Language || null,
        releaseGroup: null,
        relativePath: source.Path || null,
        added: BaseClient.formatDate(raw.DateCreated)
      } : null,
      seasons,
      raw
    };
  }

  // PROXIED ART FETCH - ITEM IMAGE PATHS ONLY, THE TOKEN RIDES THE HEADER
  async fetchImage(path) {
    if (!/^\/Items\/[^/?]+\/Images\//.test(path)) {
      throw new Error(`${this.serviceLabel} will not proxy that path`);
    }
    try {
      const res = await this.http.get(path, { responseType: 'arraybuffer' });
      return { buffer: Buffer.from(res.data), contentType: res.headers['content-type'] || 'image/jpeg' };
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  // NORMALIZED FEED ROWS - NEWEST LIBRARY ADDITIONS, NATIVELY PAGED
  async getHistory(page = 1, pageSize = 15) {
    const start = (page - 1) * pageSize;
    const data = await this._get('/Items', {
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Recursive: true,
      IncludeItemTypes: 'Movie,Episode',
      StartIndex: start,
      Limit: pageSize,
      Fields: 'DateCreated,ProductionYear,ProviderIds'
    });
    const items = data?.Items || [];
    const total = data?.TotalRecordCount ?? (start + items.length);
    return {
      rows: items.map(item => this._historyRowOf(item)),
      hasMore: start + items.length < total
    };
  }

  // SERVICE-RELATIVE POSTER PATH FOR FEED ROWS - fetchImage PROXIES IT.
  // EPISODES PREFER THE SERIES POSTER; A STILL FRAME MAKES A LOUSY THUMBNAIL.
  _historyArtOf(item) {
    if (item.Type === 'Episode' && item.SeriesId && item.SeriesPrimaryImageTag) {
      return `/Items/${item.SeriesId}/Images/Primary?maxWidth=300&quality=90`;
    }
    if (item.ImageTags?.Primary) return `/Items/${item.Id}/Images/Primary?maxWidth=300&quality=90`;
    return null;
  }

  _historyRowOf(item) {
    const base = {
      id: String(item.Id),
      kind: 'added',
      at: item.DateCreated || null,
      art: this._historyArtOf(item)
    };
    const externalIds = EmbyClient.externalIdsFrom(item);
    if (item.Type === 'Episode') {
      const code = BaseClient.seasonEpisodeCode(item.ParentIndexNumber, item.IndexNumber);
      return {
        ...base,
        title: item.SeriesName ? `${item.SeriesName} - ${item.Name}` : (item.Name || 'Unknown'),
        detail: ['Episode', code, item.ProductionYear || null].filter(Boolean).join(' • ') || null,
        media: {
          kind: 'show',
          title: item.SeriesName || item.Name,
          year: null,
          season: item.ParentIndexNumber ?? null,
          episode: item.IndexNumber ?? null,
          externalIds
        }
      };
    }
    return {
      ...base,
      title: item.Name || 'Unknown',
      detail: [item.Type || null, item.ProductionYear || null].filter(Boolean).join(' • ') || null,
      media: {
        kind: 'movie',
        title: item.Name,
        year: item.ProductionYear || null,
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

module.exports = EmbyClient;
