const ArrClient = require('./arrClient');

// LIDARR SPEAKS THE ARR CONTRACT WITH ALBUMS AS THE REQUEST UNIT - THE
// LIBRARY, SEARCH, DETAIL, AND WATCH MONITOR ALL KEY ON ALBUM IDS. ARTIST
// MANAGEMENT (ROOT MOVES, DELETION) STAYS IN LIDARR'S OWN UI FOR NOW, SO
// libraryEdit/libraryDelete/interactiveSearch ARE OFF.
class LidarrClient extends ArrClient {
  constructor(opts) {
    super(opts);
    this.serviceLabel = 'Lidarr';
  }

  get apiVersion() { return 'v1'; }

  get resource() { return 'album'; }

  get externalIdField() { return 'musicbrainz_id'; }

  get exclusionParam() { return 'addImportListExclusion'; }

  externalLookupTerm(externalKey) { return `lidarr:${externalKey}`; }

  get historyIncludeParams() { return { includeArtist: true, includeAlbum: true }; }

  historyTitleOf(record) {
    const artist = record.artist?.artistName;
    const album = record.album?.title;
    if (artist && album) return `${artist} - ${album}`;
    return album || artist || null;
  }

  get queueIncludeParams() { return { includeArtist: true, includeAlbum: true }; }

  queueMediaTitleOf(record) {
    const artist = record.artist?.artistName;
    const album = record.album?.title;
    if (artist && album) return `${artist} - ${album}`;
    return album || null;
  }

  // ALBUM ART ARRIVES AS coverType 'cover' - POSTER IS THE ARTIST-SHAPE NAME
  _albumCoverFrom(images = []) {
    const cover = images.find(img => ['cover', 'poster'].includes(img.coverType));
    const url = cover?.remoteUrl || cover?.url || null;
    return url && url.startsWith('/') ? `${this.baseUrl}${url}` : url;
  }

  normalizeLibraryItem(raw) {
    const stats = raw.statistics || {};
    const artistName = raw.artist?.artistName || '';
    const externalIds = {};
    if (raw.foreignAlbumId) externalIds.musicbrainz = String(raw.foreignAlbumId);
    return {
      id: String(raw.id),
      title: artistName ? `${artistName} - ${raw.title}` : raw.title,
      sortTitle: `${raw.artist?.sortName || artistName} ${raw.title}`.trim().toLowerCase(),
      year: raw.releaseDate ? new Date(raw.releaseDate).getFullYear() : null,
      overview: raw.overview || '',
      posterUrl: this._albumCoverFrom(raw.images),
      available: (stats.trackFileCount || 0) > 0,
      kind: 'music',
      // ALBUMS SHARE THE ARTIST FOLDER - A PATH KEY WOULD MERGE A DISCOGRAPHY
      path: null,
      externalIds
    };
  }

  // ALBUM DETAIL - MONITOR + SEARCH ARE THE ALBUM-LEVEL VERBS LIDARR OFFERS
  normalizeDetail(raw, { profileName }) {
    const stats = raw.statistics || {};
    const artist = raw.artist || {};
    return {
      id: String(raw.id),
      contentKind: 'music',
      title: raw.title,
      year: raw.releaseDate ? new Date(raw.releaseDate).getFullYear() : null,
      overview: raw.overview || '',
      posterUrl: this._albumCoverFrom(raw.images),
      fanartUrl: this.absoluteImageFrom(artist.images || [], 'fanart'),
      monitored: !!raw.monitored,
      available: (stats.trackFileCount || 0) > 0,
      availabilityLabel: `${stats.trackFileCount || 0} of ${stats.trackCount || stats.totalTrackCount || 0} tracks`,
      verbs: ['monitor', 'search'],
      status: null,
      genres: raw.genres || [],
      runtime: ArrClient.formatRuntime(Math.round((raw.duration || 0) / 60000)),
      certification: null,
      ratings: ArrClient.ratingChipsFrom(raw.ratings || {}),
      links: [
        raw.foreignAlbumId && { label: 'MusicBrainz', url: `https://musicbrainz.org/release-group/${raw.foreignAlbumId}` }
      ].filter(Boolean),
      facts: [
        { label: 'Artist', value: artist.artistName || null },
        { label: 'Album Type', value: raw.albumType || null },
        { label: 'Release Date', value: ArrClient.formatDate(raw.releaseDate) },
        { label: 'Tracks', value: stats.trackCount || stats.totalTrackCount || null },
        { label: 'Quality Profile', value: profileName },
        { label: 'Size on Disk', value: ArrClient.humanSize(stats.sizeOnDisk) || '0 B' },
        { label: 'Path', value: artist.path || null },
        { label: 'Added', value: ArrClient.formatDate(artist.added) }
      ].filter(fact => fact.value),
      file: null,
      seasons: null,
      raw
    };
  }

  // THE ALBUM ROW POINTS AT ITS ARTIST'S PROFILE - RESOLVE THE NAME OFF THAT
  async getLibraryItemDetail(arrId) {
    const [raw, profiles] = await Promise.all([
      this.getById(arrId),
      this.getQualityProfiles()
    ]);
    const profile = profiles.find(p => p.id === raw.artist?.qualityProfileId);
    return this.normalizeDetail(raw, { profileName: profile?.name || null });
  }

  searchCommandFor(arrId) {
    return { name: 'AlbumSearch', albumIds: [Number(arrId)] };
  }

  normalizeResult(raw) {
    const artistName = raw.artist?.artistName || null;
    return {
      appType: 'lidarr',
      contentType: 'music',
      title: artistName ? `${artistName} - ${raw.title}` : raw.title,
      year: raw.releaseDate ? new Date(raw.releaseDate).getFullYear() : null,
      overview: raw.overview || '',
      posterUrl: this._albumCoverFrom(raw.images),
      externalKey: String(raw.foreignAlbumId),
      musicbrainzId: raw.foreignAlbumId ? String(raw.foreignAlbumId) : null,
      tvdbId: null,
      tmdbId: null,
      imdbId: null,
      runtime: null,
      network: artistName,
      trackCount: raw.statistics?.trackCount || null,
      albumType: raw.albumType || null,
      firstAired: raw.releaseDate || null,
      seasonCount: null,
      airTime: null,
      seriesType: null,
      inTheaters: null,
      websiteUrl: null,
      trailerUrl: null,
      // A TRACKED ALBUM ALREADY CARRIES ITS LIBRARY ID
      libraryId: raw.id || null,
      raw
    };
  }

  // ADD = POST THE ALBUM WITH ITS ARTIST PAYLOAD - LIDARR CREATES/REUSES THE
  // ARTIST AND SEARCHES FOR EXACTLY THIS ALBUM. NEEDS THE LIDARR-ONLY
  // METADATA PROFILE ON TOP OF ROOT/QUALITY.
  async add(normalizedResult) {
    const [rootFolders, profiles, metadataProfiles] = await Promise.all([
      this.getRootFolders(),
      this.getQualityProfiles(),
      this.getMetadataProfiles()
    ]);
    if (!rootFolders.length) throw new Error(`${this.serviceLabel} has no root folders configured`);
    if (!profiles.length) throw new Error(`${this.serviceLabel} has no quality profiles configured`);
    if (!metadataProfiles.length) throw new Error(`${this.serviceLabel} has no metadata profiles configured`);

    const wantedRoot = this.instanceSettings.root_folder;
    const wantedProfile = Number(this.instanceSettings.quality_profile);
    const wantedMetadata = Number(this.instanceSettings.metadata_profile);
    const raw = normalizedResult.raw;
    const payload = {
      ...raw,
      monitored: true,
      artist: {
        ...raw.artist,
        rootFolderPath: rootFolders.find(folder => folder.path === wantedRoot)?.path || rootFolders[0].path,
        qualityProfileId: profiles.find(profile => profile.id === wantedProfile)?.id || profiles[0].id,
        metadataProfileId: metadataProfiles.find(profile => profile.id === wantedMetadata)?.id || metadataProfiles[0].id,
        monitored: true,
        addOptions: { monitor: 'none', searchForMissingAlbums: false }
      },
      addOptions: { searchForNewAlbum: true }
    };
    return this._post('/album', payload);
  }

  async getMetadataProfiles() {
    return this._get('/metadataprofile');
  }

  async getByExternalId(foreignAlbumId) {
    const results = await this._get('/album/lookup', { term: `lidarr:${foreignAlbumId}` });
    const hit = results?.[0];
    if (!hit?.id) return null;
    return this.getById(hit.id);
  }

  matchesQueueRecord(row, arrId) {
    return row.raw.albumId === arrId;
  }

  isImported(album) {
    const stats = album?.statistics;
    return !!stats && stats.trackFileCount > 0 && stats.percentOfTracks >= 100;
  }

  get capabilities() {
    return {
      ...super.capabilities,
      // ALBUM-LEVEL VERBS ONLY - ARTIST MANAGEMENT LIVES IN LIDARR ITSELF
      interactiveSearch: false,
      libraryEdit: false,
      libraryDelete: false
    };
  }
}

module.exports = LidarrClient;
