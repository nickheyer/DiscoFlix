const ArrClient = require('./arrClient');

class SonarrClient extends ArrClient {
  constructor(opts) {
    super(opts);
    this.serviceLabel = 'Sonarr';
  }

  get resource() { return 'series'; }

  get externalIdField() { return 'tvdb_id'; }

  externalLookupTerm(externalKey) { return `tvdb:${externalKey}`; }

  get historyIncludeParams() { return { includeSeries: true }; }

  historyTitleOf(record) { return record.series?.title || null; }

  get queueIncludeParams() { return { includeSeries: true, includeEpisode: true }; }

  queueMediaTitleOf(record) {
    const series = record.series?.title;
    if (!series) return null;
    const episode = record.episode;
    if (!episode?.seasonNumber) return series;
    const code = `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber || 0).padStart(2, '0')}`;
    return episode.title ? `${series} - ${code} - ${episode.title}` : `${series} - ${code}`;
  }

  normalizeLibraryItem(raw) {
    const stats = raw.statistics || {};
    return {
      id: String(raw.id),
      title: raw.title,
      sortTitle: raw.sortTitle || raw.title,
      year: raw.year || null,
      overview: raw.overview || '',
      posterUrl: this.absolutePosterFrom(raw.images),
      available: (stats.episodeFileCount || 0) > 0
    };
  }

  // THE DETAIL VIEW MODEL - EVERYTHING SONARR'S OWN SERIES PAGE LEANS ON,
  // SEASONS RIDE THE statistics BLOCKS ALREADY ON THE RECORD
  normalizeDetail(raw, { profileName }) {
    const stats = raw.statistics || {};
    const seasons = (raw.seasons || [])
      .map(season => {
        const seasonStats = season.statistics || {};
        return {
          number: season.seasonNumber,
          label: season.seasonNumber === 0 ? 'Specials' : `Season ${season.seasonNumber}`,
          monitored: !!season.monitored,
          episodeFileCount: seasonStats.episodeFileCount || 0,
          episodeCount: seasonStats.episodeCount || 0,
          totalEpisodeCount: seasonStats.totalEpisodeCount || 0,
          size: ArrClient.humanSize(seasonStats.sizeOnDisk),
          percent: ArrClient.clampPercent(seasonStats.percentOfEpisodes || 0)
        };
      })
      // NEWEST SEASON FIRST, SPECIALS SINK TO THE BOTTOM
      .sort((a, b) => (b.number === 0 ? -1 : b.number) - (a.number === 0 ? -1 : a.number));

    return {
      id: String(raw.id),
      contentKind: 'show',
      title: raw.title,
      year: raw.year || null,
      overview: raw.overview || '',
      posterUrl: this.absolutePosterFrom(raw.images),
      fanartUrl: this.absoluteImageFrom(raw.images, 'fanart'),
      monitored: !!raw.monitored,
      available: (stats.episodeFileCount || 0) > 0,
      availabilityLabel: `${stats.episodeFileCount || 0} of ${stats.episodeCount || 0} episodes`,
      status: raw.status || null,
      genres: raw.genres || [],
      runtime: ArrClient.formatRuntime(raw.runtime),
      certification: raw.certification || null,
      ratings: ArrClient.ratingChipsFrom(raw.ratings),
      links: [
        raw.imdbId && { label: 'IMDb', url: `https://www.imdb.com/title/${raw.imdbId}` },
        raw.tvdbId && { label: 'TVDB', url: `https://www.thetvdb.com/?tab=series&id=${raw.tvdbId}` }
      ].filter(Boolean),
      facts: [
        { label: 'Status', value: raw.status === 'continuing' ? 'Continuing' : (raw.status === 'ended' ? 'Ended' : raw.status) },
        { label: 'Network', value: raw.network || null },
        { label: 'Airs', value: raw.airTime ? `${raw.airTime}${raw.network ? ' on ' + raw.network : ''}` : null },
        { label: 'Quality Profile', value: profileName },
        { label: 'Size on Disk', value: ArrClient.humanSize(stats.sizeOnDisk) || '0 B' },
        { label: 'Path', value: raw.path || null },
        { label: 'First Aired', value: ArrClient.formatDate(raw.firstAired) },
        { label: 'Next Airing', value: ArrClient.formatDate(raw.nextAiring) },
        { label: 'Previous Airing', value: ArrClient.formatDate(raw.previousAiring) },
        { label: 'Series Type', value: raw.seriesType && raw.seriesType !== 'standard' ? raw.seriesType : null },
        { label: 'Added', value: ArrClient.formatDate(raw.added) }
      ].filter(fact => fact.value),
      file: null,
      seasons,
      raw
    };
  }

  searchCommandFor(arrId) {
    return { name: 'SeriesSearch', seriesId: Number(arrId) };
  }

  normalizeResult(raw) {
    const realSeasons = (raw.seasons || []).filter(season => season.seasonNumber > 0);
    return {
      appType: 'sonarr',
      contentType: 'show',
      title: raw.title,
      year: raw.year || null,
      overview: raw.overview || '',
      posterUrl: ArrClient.posterFrom(raw.images),
      externalKey: String(raw.tvdbId),
      tvdbId: raw.tvdbId ? String(raw.tvdbId) : null,
      imdbId: raw.imdbId || null,
      runtime: raw.runtime || null,
      network: raw.network || null,
      seasonCount: raw.statistics?.seasonCount ?? realSeasons.length,
      airTime: raw.airTime || null,
      firstAired: raw.firstAired || null,
      seriesType: raw.seriesType || null,
      inTheaters: null,
      websiteUrl: null,
      trailerUrl: null,
      libraryId: raw.id || null,
      raw
    };
  }

  buildAddPayload(raw, { rootFolderPath, qualityProfileId }) {
    return {
      ...raw,
      rootFolderPath,
      qualityProfileId,
      languageProfileId: 1, // REQUIRED BY SONARR v3, IGNORED BY v4
      monitored: true,
      seasonFolder: true,
      addOptions: { searchForMissingEpisodes: true }
    };
  }

  async getByExternalId(tvdbId) {
    const matches = await this._get('/series', { tvdbId });
    return matches?.[0] || null;
  }

  matchesQueueRecord(row, arrId) {
    return row.raw.seriesId === arrId;
  }

  isImported(series) {
    const stats = series?.statistics;
    return !!stats && stats.episodeFileCount > 0 && stats.percentOfEpisodes >= 100;
  }
}

module.exports = SonarrClient;
