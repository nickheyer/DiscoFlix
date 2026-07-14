const axios = require('axios');
const BaseClient = require('./baseClient');

// ARR /history eventType -> NORMALIZED FEED KIND (SEE baseClient CONTRACT)
const HISTORY_EVENT_KINDS = {
  grabbed: 'grabbed',
  downloadFolderImported: 'imported',
  trackFileImported: 'imported',
  downloadFailed: 'failed',
  albumImportIncomplete: 'failed',
  downloadIgnored: 'ignored',
  movieFileDeleted: 'deleted',
  episodeFileDeleted: 'deleted',
  trackFileDeleted: 'deleted',
  movieFileRenamed: 'renamed',
  episodeFileRenamed: 'renamed',
  trackFileRenamed: 'renamed'
};

// SHARED HTTP CLIENT FOR THE *ARR API (CONTENT-MANAGER FAMILY). RADARR/SONARR
// SPEAK v3, LIDARR STILL SHIPS v1 - apiVersion IS THE SUBCLASS HOOK.
class ArrClient extends BaseClient {
  constructor({ url, token, logger, settings }) {
    super({ url, logger });
    this.serviceLabel = 'Arr';
    // PER-INSTANCE DEFAULTS OFF App.settings_json (root_folder/quality_profile)
    this.instanceSettings = settings || {};
    this.http = axios.create({
      baseURL: `${this.baseUrl}/api/${this.apiVersion}`,
      timeout: 10000,
      headers: { 'X-Api-Key': token }
    });
  }

  get apiVersion() { return 'v3'; }

  async _get(path, params = {}, config = {}) {
    try {
      const { data } = await this.http.get(path, { params, ...config });
      return data;
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async _post(path, body = {}) {
    try {
      const { data } = await this.http.post(path, body);
      return data;
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async _put(path, body = {}) {
    try {
      const { data } = await this.http.put(path, body);
      return data;
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async _delete(path, params = {}) {
    try {
      const { data } = await this.http.delete(path, { params });
      return data;
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  // SHARED API SURFACE
  async getStatus() {
    return this._get('/system/status');
  }

  async getQueue() {
    const data = await this._get('/queue', { page: 1, pageSize: 1000, ...this.queueIncludeParams });
    return (data.records || []).map(record => this._normalizeQueueRecord(record));
  }

  // STATUS MESSAGES + ERROR ROLL UP INTO warnings - THE QUEUE UI'S TOOLTIP
  _queueWarningsOf(record) {
    const warnings = (record.statusMessages || []).flatMap(status =>
      status.messages?.length ? status.messages : [status.title]
    ).filter(Boolean);
    if (record.errorMessage) warnings.push(record.errorMessage);
    return warnings;
  }

  _normalizeQueueRecord(record) {
    const size = record.size || 0;
    const sizeleft = record.sizeleft || 0;
    return {
      id: String(record.id),
      title: this.queueMediaTitleOf(record) || record.title || 'Unknown',
      subtitle: record.title || null,
      status: (record.status || 'queued').toLowerCase(),
      percent: size ? BaseClient.clampPercent(((size - sizeleft) / size) * 100) : 0,
      timeleft: record.timeleft || null,
      size: size || null,
      sizeleft: size ? sizeleft : null,
      sizeHuman: BaseClient.humanSize(size),
      sizeleftHuman: BaseClient.humanSize(sizeleft),
      quality: record.quality?.quality?.name || null,
      protocol: record.protocol || null,
      downloadClient: record.downloadClient || null,
      indexer: record.indexer || null,
      category: null,
      speed: null,
      seeds: null,
      warnings: this._queueWarningsOf(record),
      raw: record
    };
  }

  async getHealth() {
    return this._get('/health');
  }

  // remove DROPS THE ITEM AND ITS DOWNLOAD, blocklist ALSO BANS THAT RELEASE
  async queueAction(verb, id) {
    if (verb !== 'remove' && verb !== 'blocklist') {
      throw new Error(`${this.serviceLabel} cannot '${verb}' a queue item`);
    }
    return this._delete(`/queue/${id}`, { removeFromClient: true, blocklist: verb === 'blocklist' });
  }

  // FULL LIBRARY LISTING (/movie OR /series) - THE LIBRARY SECTION'S SOURCE.
  // SORTED FOR BROWSING; PAGING IS SLICED SERVER-SIDE FROM THE CACHED LIST.
  async getLibrary() {
    const items = (await this._get(`/${this.resource}`))
      .map(raw => this.normalizeLibraryItem(raw));
    return items.sort((a, b) => (a.sortTitle || a.title || '').localeCompare(b.sortTitle || b.title || ''));
  }

  // NATIVELY PAGED /history, MAPPED TO NORMALIZED FEED ROWS
  async getHistory(page = 1, pageSize = 15) {
    const data = await this._get('/history', {
      page,
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending',
      ...this.historyIncludeParams
    });
    const records = data.records || [];
    return {
      rows: records.map(record => ({
        id: String(record.id),
        kind: HISTORY_EVENT_KINDS[record.eventType] || 'info',
        title: this.historyTitleOf(record) || record.sourceTitle || 'Unknown',
        detail: record.quality?.quality?.name || null,
        at: record.date || null
      })),
      hasMore: page * pageSize < (data.totalRecords || 0)
    };
  }

  async getRootFolders() {
    return this._get('/rootfolder');
  }

  async getQualityProfiles() {
    return this._get('/qualityprofile');
  }

  // MOUNTED DISKS AS THE ARR SEES THEM - THE OVERVIEW'S STORAGE SECTION.
  // RADARR/SONARR v3 AND LIDARR v1 ALL ANSWER GET /diskspace THE SAME WAY:
  // [{ path, label, freeSpace, totalSpace }]
  async getDiskSpace() {
    return this._get('/diskspace');
  }

  async search(term) {
    const results = await this._get(`/${this.resource}/lookup`, { term });
    return (results || []).map(raw => this.normalizeResult(raw));
  }

  // RE-FETCH A FULL LOOKUP RESULT BY THE SERVICE'S PRIMARY EXTERNAL ID
  // (USED AT APPROVE TIME, WHEN ONLY THE Media ROW IS ON HAND)
  async lookupByExternalId(externalKey) {
    const results = await this.search(this.externalLookupTerm(externalKey));
    return results[0] || null;
  }

  async getById(arrId) {
    return this._get(`/${this.resource}/${arrId}`);
  }

  // FULL LIBRARY-ITEM DETAIL - THE RECORD, THE PROFILE NAME IT POINTS AT, AND
  // THE MANAGE PANEL'S OPTION LISTS (PROFILES + ROOTS WITH CURRENT VALUES)
  async getLibraryItemDetail(arrId) {
    const [raw, profiles, rootFolders] = await Promise.all([
      this.getById(arrId),
      this.getQualityProfiles(),
      this.getRootFolders()
    ]);
    const profile = profiles.find(p => p.id === raw.qualityProfileId);
    const detail = this.normalizeDetail(raw, { profileName: profile?.name || null });
    const roots = rootFolders.map(folder => ArrClient.trimTrailingSlashes(folder.path));
    detail.editOptions = {
      profiles: profiles.map(p => ({ id: p.id, name: p.name })),
      rootFolders: roots,
      currentProfileId: raw.qualityProfileId || null,
      currentRootFolder: ArrClient.trimTrailingSlashes(raw.rootFolderPath)
        || roots.find(root => String(raw.path || '').startsWith(root))
        || null
    };
    return detail;
  }

  // DETAIL VIEW MODEL FROM A LOOKUP RESULT - THE EPHEMERAL PRE-ADD TWIN OF
  // getLibraryItemDetail; LIBRARY-OWNED FACTS AND FILE/SEASON DATA DROP OUT
  normalizeLookupDetail(raw) {
    const detail = this.normalizeDetail(raw, { profileName: null });
    const libraryFacts = ['Quality Profile', 'Size on Disk', 'Path', 'Added'];
    return {
      ...detail,
      id: null,
      monitored: false,
      available: false,
      availabilityLabel: 'Not in library',
      file: null,
      seasons: null,
      facts: detail.facts.filter(fact => !libraryFacts.includes(fact.label))
    };
  }

  // FLIP MONITORING BY ROUND-TRIPPING THE FULL RECORD (THE ARR PUT CONTRACT)
  async setMonitored(arrId, monitored) {
    const raw = await this.getById(arrId);
    return this._put(`/${this.resource}/${raw.id}`, { ...raw, monitored: !!monitored });
  }

  // KICK THE ARR'S OWN AUTOMATIC SEARCH FOR ONE LIBRARY ITEM
  async triggerItemSearch(arrId) {
    return this._post('/command', this.searchCommandFor(arrId));
  }

  // INTERACTIVE SEARCH - THE ARR SWEEPS ITS INDEXERS LIVE AND RETURNS EVERY
  // CANDIDATE RELEASE. SLOW BY NATURE, SO THIS CALL GETS ITS OWN LONG TIMEOUT.
  async getInteractiveReleases(scope = {}) {
    const releases = await this._get('/release', this.releaseParamsFor(scope), { timeout: 90000 });
    return (releases || [])
      .map(raw => this._normalizeInteractiveRelease(raw))
      .sort((a, b) => (a.rejected ? 1 : 0) - (b.rejected ? 1 : 0) || (b.seeders || 0) - (a.seeders || 0));
  }

  _normalizeInteractiveRelease(raw) {
    return {
      guid: raw.guid,
      indexerId: raw.indexerId,
      title: raw.title || 'Unknown release',
      indexer: raw.indexer || null,
      quality: raw.quality?.quality?.name || null,
      protocol: raw.protocol === 'usenet' ? 'usenet' : 'torrent',
      sizeHuman: ArrClient.humanSize(raw.size),
      seeders: raw.seeders ?? null,
      age: ArrClient.humanAge(raw.publishDate) || (raw.age != null ? `${raw.age}d` : null),
      languages: (raw.languages || []).map(lang => lang.name).filter(Boolean).join(', ') || null,
      rejected: !!raw.rejected,
      rejections: raw.rejections || []
    };
  }

  // HAND A PICKED RELEASE BACK TO THE ARR - IT GRABS VIA ITS OWN CLIENTS
  async grabRelease(guid, indexerId) {
    return this._post('/release', { guid, indexerId, shouldOverride: false });
  }

  // EDIT THE LIBRARY-OWNED SETTINGS (QUALITY PROFILE / ROOT FOLDER). A ROOT
  // MOVE RECOMPUTES path FROM THE OLD FOLDER NAME, moveFiles RIDES THE QUERY.
  async updateItemSettings(arrId, { qualityProfileId, rootFolderPath, moveFiles = false } = {}) {
    const raw = await this.getById(arrId);
    const body = { ...raw };
    if (qualityProfileId) body.qualityProfileId = Number(qualityProfileId);
    const wantedRoot = rootFolderPath ? ArrClient.trimTrailingSlashes(rootFolderPath) : null;
    // A ROOT THE ITEM ALREADY LIVES UNDER IS A NO-OP, NEVER A MOVE
    if (wantedRoot && !String(raw.path || '').startsWith(wantedRoot)) {
      const separator = wantedRoot.includes('\\') ? '\\' : '/';
      const folderName = String(raw.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      body.rootFolderPath = wantedRoot;
      if (folderName) body.path = `${wantedRoot}${separator}${folderName}`;
    }
    return this._put(`/${this.resource}/${raw.id}?moveFiles=${moveFiles ? 'true' : 'false'}`, body);
  }

  // DROP THE ITEM FROM THE LIBRARY - FILE DELETION AND LIST EXCLUSION ARE THE
  // OPERATOR'S EXPLICIT CALLS, NEVER DEFAULTS
  async deleteItem(arrId, { deleteFiles = false, addExclusion = false } = {}) {
    return this._delete(`/${this.resource}/${arrId}`, {
      deleteFiles: !!deleteFiles,
      [this.exclusionParam]: !!addExclusion
    });
  }

  // THE OPTION LISTS AN ADD (OR A PRE-ADD PICKER UI) CHOOSES FROM
  async getAddOptions() {
    const [rootFolders, profiles] = await Promise.all([
      this.getRootFolders(),
      this.getQualityProfiles()
    ]);
    return { rootFolders, profiles };
  }

  // ADD TO LIBRARY (MONITORED + SEARCH-ON-ADD). EXPLICIT OVERRIDES WIN, THEN
  // INSTANCE SETTINGS PICK THE ROOT FOLDER AND QUALITY PROFILE; A STALE OR
  // EMPTY VALUE FALLS BACK TO THE SERVICE'S FIRST. seasons THREADS THROUGH
  // FOR SONARR MONITORING.
  async add(normalizedResult, { seasons = null, qualityProfileId = null, rootFolderPath = null } = {}) {
    const { rootFolders, profiles } = await this.getAddOptions();
    if (!rootFolders.length) throw new Error(`${this.serviceLabel} has no root folders configured`);
    if (!profiles.length) throw new Error(`${this.serviceLabel} has no quality profiles configured`);

    const wantedRoot = rootFolderPath || this.instanceSettings.root_folder;
    const wantedProfile = Number(qualityProfileId || this.instanceSettings.quality_profile);
    const payload = this.buildAddPayload(normalizedResult.raw, {
      rootFolderPath: rootFolders.find(folder => folder.path === wantedRoot)?.path || rootFolders[0].path,
      qualityProfileId: profiles.find(profile => profile.id === wantedProfile)?.id || profiles[0].id,
      seasons
    });
    return this._post(`/${this.resource}`, payload);
  }

  get capabilities() {
    return {
      ...super.capabilities,
      search: true,
      add: true,
      library: true,
      libraryDetail: true,
      // DETAIL PHASE 2 - RELEASE PICKING, SETTINGS EDIT, AND ITEM REMOVAL
      interactiveSearch: true,
      libraryEdit: true,
      libraryDelete: true,
      health: true,
      diskSpace: true,
      // ARRS PAUSE AT THE DOWNLOAD CLIENT, NOT PER QUEUE ITEM
      queueActions: { item: ['remove', 'blocklist'], queue: [] }
    };
  }

  // SUBCLASS CONTRACT
  get resource() { throw new Error('NOT_IMPLEMENTED'); }
  get externalIdField() { throw new Error('NOT_IMPLEMENTED'); } // Media COLUMN HOLDING THE ARR'S KEY
  get exclusionParam() { throw new Error('NOT_IMPLEMENTED'); } // DELETE'S ADD-EXCLUSION QUERY FLAG
  releaseParamsFor() { throw new Error('NOT_IMPLEMENTED'); } // ({ arrId, season, episodeId }) -> /release PARAMS
  get historyIncludeParams() { return {}; } // /history EXPANSION FLAGS (includeMovie/includeSeries)
  get queueIncludeParams() { return {}; } // /queue EXPANSION FLAGS (includeMovie/includeSeries)
  historyTitleOf() { return null; } // MEDIA TITLE OFF AN EXPANDED HISTORY RECORD
  queueMediaTitleOf() { return null; } // MEDIA TITLE OFF AN EXPANDED QUEUE RECORD
  normalizeResult() { throw new Error('NOT_IMPLEMENTED'); }
  normalizeLibraryItem() { throw new Error('NOT_IMPLEMENTED'); } // -> { id, title, sortTitle, year, overview, posterUrl, available }
  normalizeDetail() { throw new Error('NOT_IMPLEMENTED'); } // (raw, { profileName }) -> DETAIL VIEW MODEL
  searchCommandFor() { throw new Error('NOT_IMPLEMENTED'); } // (arrId) -> /command PAYLOAD
  buildAddPayload() { throw new Error('NOT_IMPLEMENTED'); }
  getByExternalId() { throw new Error('NOT_IMPLEMENTED'); }
  matchesQueueRecord() { throw new Error('NOT_IMPLEMENTED'); } // (normalizedRow, arrId)
  isImported() { throw new Error('NOT_IMPLEMENTED'); }

  static trimTrailingSlashes(value) {
    return String(value || '').replace(/[\\/]+$/, '');
  }

  // POSTER HELPER FOR normalizeResult
  static posterFrom(images = []) {
    const poster = images.find(img => img.coverType === 'poster');
    return poster?.remoteUrl || poster?.url || null;
  }

  // LIBRARY ROWS OFTEN ONLY CARRY THE ARR-LOCAL /MediaCover PATH - ABSOLUTIZE
  // AGAINST THE INSTANCE URL SO THE BROWSER CAN LOAD IT
  absoluteImageFrom(images = [], coverType = 'poster') {
    const image = images.find(img => img.coverType === coverType);
    const url = image?.remoteUrl || image?.url || null;
    return url && url.startsWith('/') ? `${this.baseUrl}${url}` : url;
  }

  absolutePosterFrom(images = []) {
    return this.absoluteImageFrom(images, 'poster');
  }

  // RATINGS ARRIVE SERVICE-SHAPED (RADARR PER-SOURCE, SONARR FLAT) - FLATTEN
  // THE POPULATED ONES TO CHIP ROWS
  static ratingChipsFrom(ratings = {}) {
    const sources = [
      ['imdb', 'IMDb', value => value.toFixed(1)],
      ['tmdb', 'TMDB', value => value.toFixed(1)],
      ['metacritic', 'Metacritic', value => String(Math.round(value))],
      ['rottenTomatoes', 'Rotten Tomatoes', value => `${Math.round(value)}%`]
    ];
    const chips = [];
    for (const [key, label, format] of sources) {
      const entry = ratings[key];
      if (typeof entry?.value !== 'number' || entry.value <= 0) continue;
      chips.push({ label, value: format(entry.value), votes: entry.votes || null });
    }
    if (!chips.length && typeof ratings.value === 'number' && ratings.value > 0) {
      chips.push({ label: 'Rating', value: ratings.value.toFixed(1), votes: ratings.votes || null });
    }
    return chips;
  }

}

module.exports = ArrClient;
