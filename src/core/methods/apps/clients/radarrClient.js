const ArrClient = require('./arrClient');

class RadarrClient extends ArrClient {
  constructor(opts) {
    super(opts);
    this.serviceLabel = 'Radarr';
  }

  get resource() { return 'movie'; }

  get externalIdField() { return 'tmdb_id'; }

  externalLookupTerm(externalKey) { return `tmdb:${externalKey}`; }

  get historyIncludeParams() { return { includeMovie: true }; }

  historyTitleOf(record) { return record.movie?.title || null; }

  get queueIncludeParams() { return { includeMovie: true }; }

  queueMediaTitleOf(record) {
    const movie = record.movie;
    if (!movie?.title) return null;
    return movie.year ? `${movie.title} (${movie.year})` : movie.title;
  }

  normalizeLibraryItem(raw) {
    return {
      id: String(raw.id),
      title: raw.title,
      sortTitle: raw.sortTitle || raw.title,
      year: raw.year || null,
      overview: raw.overview || '',
      posterUrl: this.absolutePosterFrom(raw.images),
      available: !!raw.hasFile
    };
  }

  // THE DETAIL VIEW MODEL - EVERYTHING RADARR'S OWN MOVIE PAGE LEANS ON
  normalizeDetail(raw, { profileName }) {
    const mediaInfo = raw.movieFile?.mediaInfo || {};
    return {
      id: String(raw.id),
      contentKind: 'movie',
      title: raw.title,
      year: raw.year || null,
      overview: raw.overview || '',
      posterUrl: this.absolutePosterFrom(raw.images),
      fanartUrl: this.absoluteImageFrom(raw.images, 'fanart'),
      monitored: !!raw.monitored,
      available: !!raw.hasFile,
      availabilityLabel: raw.hasFile ? 'Downloaded' : 'Missing',
      verbs: ['monitor', 'search'],
      status: raw.status || null,
      genres: raw.genres || [],
      runtime: ArrClient.formatRuntime(raw.runtime),
      certification: raw.certification || null,
      ratings: ArrClient.ratingChipsFrom(raw.ratings),
      links: [
        raw.imdbId && { label: 'IMDb', url: `https://www.imdb.com/title/${raw.imdbId}` },
        raw.tmdbId && { label: 'TMDB', url: `https://www.themoviedb.org/movie/${raw.tmdbId}` },
        raw.youTubeTrailerId && { label: 'Trailer', url: `https://youtu.be/${raw.youTubeTrailerId}` }
      ].filter(Boolean),
      facts: [
        { label: 'Status', value: raw.status === 'released' ? 'Released' : (raw.status || null) },
        { label: 'Studio', value: raw.studio || null },
        { label: 'Quality Profile', value: profileName },
        { label: 'Size on Disk', value: ArrClient.humanSize(raw.sizeOnDisk) || '0 B' },
        { label: 'Path', value: raw.path || null },
        { label: 'In Cinemas', value: ArrClient.formatDate(raw.inCinemas) },
        { label: 'Digital Release', value: ArrClient.formatDate(raw.digitalRelease) },
        { label: 'Physical Release', value: ArrClient.formatDate(raw.physicalRelease) },
        { label: 'Original Language', value: raw.originalLanguage?.name || null },
        { label: 'Added', value: ArrClient.formatDate(raw.added) }
      ].filter(fact => fact.value),
      file: raw.movieFile ? {
        quality: raw.movieFile.quality?.quality?.name || null,
        size: ArrClient.humanSize(raw.movieFile.size),
        resolution: mediaInfo.resolution || null,
        videoCodec: mediaInfo.videoCodec || null,
        audioCodec: mediaInfo.audioCodec || null,
        audioChannels: mediaInfo.audioChannels || null,
        dynamicRange: mediaInfo.videoDynamicRangeType || mediaInfo.videoDynamicRange || null,
        languages: (raw.movieFile.languages || []).map(lang => lang.name).join(', ') || null,
        releaseGroup: raw.movieFile.releaseGroup || null,
        relativePath: raw.movieFile.relativePath || null,
        added: ArrClient.formatDate(raw.movieFile.dateAdded)
      } : null,
      seasons: null,
      raw
    };
  }

  searchCommandFor(arrId) {
    return { name: 'MoviesSearch', movieIds: [Number(arrId)] };
  }

  normalizeResult(raw) {
    return {
      appType: 'radarr',
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

  matchesQueueRecord(row, arrId) {
    return row.raw.movieId === arrId;
  }

  isImported(movie) {
    return !!movie?.hasFile;
  }
}

module.exports = RadarrClient;
