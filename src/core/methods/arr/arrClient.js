const axios = require('axios');

// SHARED HTTP CLIENT FOR THE *ARR v3 API
class ArrClient {
  constructor({ url, token, logger }) {
    this.serviceLabel = 'Arr';
    this.logger = logger;
    this.baseUrl = ArrClient.normalizeUrl(url);
    this.http = axios.create({
      baseURL: `${this.baseUrl}/api/v3`,
      timeout: 10000,
      headers: { 'X-Api-Key': token }
    });
  }

  static normalizeUrl(url) {
    let normalized = String(url || '').trim().replace(/\/+$/, '');
    if (normalized && !/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }
    return normalized;
  }

  // ERRORS ARE REWRAPPED WITH A USER-PRESENTABLE MESSAGE — THE REQUEST FLOW
  // ECHOES `err.message` STRAIGHT INTO DISCORD
  _normalizeError(err) {
    let message;
    if (err.response) {
      message = err.response.status === 401
        ? `${this.serviceLabel} rejected the configured API key`
        : `${this.serviceLabel} responded with HTTP ${err.response.status}`;
    } else if (err.request) {
      message = `${this.serviceLabel} is unreachable at ${this.baseUrl}`;
    } else {
      message = `${this.serviceLabel} request failed: ${err.message}`;
    }
    const wrapped = new Error(message);
    wrapped.cause = err;
    return wrapped;
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
    return data.records || [];
  }

  async getHealth() {
    return this._get('/health');
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

  // SUBCLASS CONTRACT
  get resource() { throw new Error('NOT_IMPLEMENTED'); }
  normalizeResult() { throw new Error('NOT_IMPLEMENTED'); }
  buildAddPayload() { throw new Error('NOT_IMPLEMENTED'); }
  getByExternalId() { throw new Error('NOT_IMPLEMENTED'); }
  matchesQueueRecord() { throw new Error('NOT_IMPLEMENTED'); }
  isImported() { throw new Error('NOT_IMPLEMENTED'); }

  // POSTER HELPER FOR normalizeResult
  static posterFrom(images = []) {
    const poster = images.find(img => img.coverType === 'poster');
    return poster?.remoteUrl || poster?.url || null;
  }
}

module.exports = ArrClient;
