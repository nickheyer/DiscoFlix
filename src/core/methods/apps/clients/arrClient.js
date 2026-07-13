const axios = require('axios');
const BaseClient = require('./baseClient');

// ARR /history eventType -> NORMALIZED FEED KIND (SEE baseClient CONTRACT)
const HISTORY_EVENT_KINDS = {
  grabbed: 'grabbed',
  downloadFolderImported: 'imported',
  downloadFailed: 'failed',
  downloadIgnored: 'ignored',
  movieFileDeleted: 'deleted',
  episodeFileDeleted: 'deleted',
  movieFileRenamed: 'renamed',
  episodeFileRenamed: 'renamed'
};

// SHARED HTTP CLIENT FOR THE *ARR v3 API (CONTENT-MANAGER FAMILY)
class ArrClient extends BaseClient {
  constructor({ url, token, logger, settings }) {
    super({ url, logger });
    this.serviceLabel = 'Arr';
    // PER-INSTANCE DEFAULTS OFF App.settings_json (root_folder/quality_profile)
    this.instanceSettings = settings || {};
    this.http = axios.create({
      baseURL: `${this.baseUrl}/api/v3`,
      timeout: 10000,
      headers: { 'X-Api-Key': token }
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

  // FULL LIBRARY-ITEM DETAIL - THE RECORD PLUS THE PROFILE NAME IT POINTS AT
  async getLibraryItemDetail(arrId) {
    const [raw, profiles] = await Promise.all([
      this.getById(arrId),
      this.getQualityProfiles()
    ]);
    const profile = profiles.find(p => p.id === raw.qualityProfileId);
    return this.normalizeDetail(raw, { profileName: profile?.name || null });
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

  // ADD TO LIBRARY (MONITORED + SEARCH-ON-ADD). INSTANCE SETTINGS PICK THE
  // ROOT FOLDER AND QUALITY PROFILE; A STALE OR EMPTY SETTING FALLS BACK TO
  // THE SERVICE'S FIRST. seasons THREADS THROUGH FOR SONARR MONITORING.
  async add(normalizedResult, { seasons = null } = {}) {
    const [rootFolders, profiles] = await Promise.all([
      this.getRootFolders(),
      this.getQualityProfiles()
    ]);
    if (!rootFolders.length) throw new Error(`${this.serviceLabel} has no root folders configured`);
    if (!profiles.length) throw new Error(`${this.serviceLabel} has no quality profiles configured`);

    const wantedRoot = this.instanceSettings.root_folder;
    const wantedProfile = Number(this.instanceSettings.quality_profile);
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
      health: true,
      // ARRS PAUSE AT THE DOWNLOAD CLIENT, NOT PER QUEUE ITEM
      queueActions: { item: ['remove', 'blocklist'], queue: [] }
    };
  }

  // SUBCLASS CONTRACT
  get resource() { throw new Error('NOT_IMPLEMENTED'); }
  get externalIdField() { throw new Error('NOT_IMPLEMENTED'); } // Media COLUMN HOLDING THE ARR'S KEY
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
