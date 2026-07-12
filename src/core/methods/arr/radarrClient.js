const ArrClient = require('./arrClient');

class RadarrClient extends ArrClient {
  constructor(opts) {
    super(opts);
    this.serviceLabel = 'Radarr';
  }

  get resource() { return 'movie'; }

  externalLookupTerm(externalKey) { return `tmdb:${externalKey}`; }

  normalizeResult(raw) {
    return {
      service: 'radarr',
      contentType: 'movie',
      title: raw.title,
      year: raw.year || null,
      overview: raw.overview || '',
      posterUrl: ArrClient.posterFrom(raw.images),
      externalKey: String(raw.tmdbId),
      tmdbId: raw.tmdbId ? String(raw.tmdbId) : null,
      imdbId: raw.imdbId || null,
      runtime: raw.runtime || null,
      network: raw.studio || null,
      inTheaters: raw.inCinemas || null,
      websiteUrl: raw.website || null,
      trailerUrl: raw.youTubeTrailerId ? `https://youtu.be/${raw.youTubeTrailerId}` : null,
      seasonCount: null,
      airTime: null,
      firstAired: null,
      seriesType: null,
      // LOOKUP RESULTS ALREADY IN THE LIBRARY CARRY THEIR LIBRARY ID
      libraryId: raw.id || null,
      raw
    };
  }

  buildAddPayload(raw, { rootFolderPath, qualityProfileId }) {
    return {
      ...raw,
      rootFolderPath,
      qualityProfileId,
      monitored: true,
      addOptions: { searchForMovie: true }
    };
  }

  async getByExternalId(tmdbId) {
    const matches = await this._get('/movie', { tmdbId });
    return matches?.[0] || null;
  }

  matchesQueueRecord(record, arrId) {
    return record.movieId === arrId;
  }

  isImported(movie) {
    return !!movie?.hasFile;
  }
}

module.exports = RadarrClient;
