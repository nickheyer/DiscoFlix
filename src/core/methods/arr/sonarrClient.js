const ArrClient = require('./arrClient');

class SonarrClient extends ArrClient {
  constructor(opts) {
    super(opts);
    this.serviceLabel = 'Sonarr';
  }

  get resource() { return 'series'; }

  externalLookupTerm(externalKey) { return `tvdb:${externalKey}`; }

  normalizeResult(raw) {
    const realSeasons = (raw.seasons || []).filter(season => season.seasonNumber > 0);
    return {
      service: 'sonarr',
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

  matchesQueueRecord(record, arrId) {
    return record.seriesId === arrId;
  }

  isImported(series) {
    const stats = series?.statistics;
    return !!stats && stats.episodeFileCount > 0 && stats.percentOfEpisodes >= 100;
  }
}

module.exports = SonarrClient;
