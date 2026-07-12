const axios = require('axios');
const BaseClient = require('./baseClient');

// SHARED HTTP CLIENT FOR THE *ARR v3 API (CONTENT-MANAGER FAMILY)
class ArrClient extends BaseClient {
  constructor({ url, token, logger }) {
    super({ url, logger });
    this.serviceLabel = 'Arr';
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

  // SHARED API SURFACE
  async getStatus() {
    return this._get('/system/status');
  }

  async getQueue() {
    const data = await this._get('/queue', { page: 1, pageSize: 1000 });
    return (data.records || []).map(record => this._normalizeQueueRecord(record));
  }

  _normalizeQueueRecord(record) {
    const size = record.size || 0;
    const sizeleft = record.sizeleft || 0;
    return {
      id: String(record.id),
      title: record.title || 'Unknown',
      status: (record.status || 'queued').toLowerCase(),
      percent: size ? BaseClient.clampPercent(((size - sizeleft) / size) * 100) : 0,
      timeleft: record.timeleft || null,
      size: size || null,
      sizeleft: size ? sizeleft : null,
      raw: record
    };
  }

  async getHealth() {
    return this._get('/health');
  }

  // FULL LIBRARY LISTING (/movie OR /series) — THE LIBRARY SECTION'S SOURCE
  async getAll() {
    return this._get(`/${this.resource}`);
  }

  // NATIVELY PAGED — RETURNS { records, totalRecords, page, pageSize }
  async getHistory(page = 1, pageSize = 30) {
    return this._get('/history', {
      page,
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending'
    });
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

  // ADD TO LIBRARY (MONITORED + SEARCH-ON-ADD), DEFAULTING TO THE FIRST
  // ROOT FOLDER AND QUALITY PROFILE — PER-REQUEST SELECTION IS BACKLOGGED
  async add(normalizedResult) {
    const [rootFolders, profiles] = await Promise.all([
      this.getRootFolders(),
      this.getQualityProfiles()
    ]);
    if (!rootFolders.length) throw new Error(`${this.serviceLabel} has no root folders configured`);
    if (!profiles.length) throw new Error(`${this.serviceLabel} has no quality profiles configured`);

    const payload = this.buildAddPayload(normalizedResult.raw, {
      rootFolderPath: rootFolders[0].path,
      qualityProfileId: profiles[0].id
    });
    return this._post(`/${this.resource}`, payload);
  }

  get capabilities() {
    return { search: true, add: true, library: true, health: true, pauseResume: false };
  }

  // SUBCLASS CONTRACT
  get resource() { throw new Error('NOT_IMPLEMENTED'); }
  get externalIdField() { throw new Error('NOT_IMPLEMENTED'); } // Media COLUMN HOLDING THE ARR'S KEY
  normalizeResult() { throw new Error('NOT_IMPLEMENTED'); }
  buildAddPayload() { throw new Error('NOT_IMPLEMENTED'); }
  getByExternalId() { throw new Error('NOT_IMPLEMENTED'); }
  matchesQueueRecord() { throw new Error('NOT_IMPLEMENTED'); } // (normalizedRow, arrId)
  isImported() { throw new Error('NOT_IMPLEMENTED'); }

  // POSTER HELPER FOR normalizeResult
  static posterFrom(images = []) {
    const poster = images.find(img => img.coverType === 'poster');
    return poster?.remoteUrl || poster?.url || null;
  }
}

module.exports = ArrClient;
