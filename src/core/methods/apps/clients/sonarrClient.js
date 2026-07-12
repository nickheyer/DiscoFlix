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

  normalizeLibraryItem(raw) {
    const stats = raw.statistics || {};
    return {
      id: String(raw.id),
      title: raw.title,
      sortTitle: raw.sortTitle || raw.title,
      year: raw.year || null,
      posterUrl: this.absolutePosterFrom(raw.images),
      available: (stats.episodeFileCount || 0) > 0
    };
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
