const axios = require('axios');
const BaseClient = require('./baseClient');
const tuning = require('../../../tuning');

// JACKETT - THE TORZNAB CAPS FEED IS THE AUTHORITATIVE APIKEY-GATED
// CONNECTIVITY CHECK; THE ADMIN CONFIG ENDPOINT ADDS A VERSION WHEN IT
// ISN'T LOCKED BEHIND THE ADMIN PASSWORD. RELEASE SEARCH RIDES THE JSON
// AGGREGATE (EVERY CONFIGURED INDEXER AT ONCE); GRABS HAND THE RESULT LINK
// TO A CONNECTED TORRENT CLIENT.
class JackettClient extends BaseClient {
  constructor({ url, apiKey, logger }) {
    super({ url, logger });
    this.serviceLabel = 'Jackett';
    this.apiKey = apiKey;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: tuning.value('indexer_http_timeout_seconds') * 1000 });
  }

  async getStatus() {
    let caps;
    try {
      ({ data: caps } = await this.http.get('/api/v2.0/indexers/all/results/torznab/api', {
        params: { apikey: this.apiKey, t: 'caps' }
      }));
    } catch (err) {
      throw this._normalizeError(err);
    }
    const text = String(caps);
    if (/<error/i.test(text)) {
      const description = text.match(/description="([^"]*)"/)?.[1] || '';
      throw new Error(/api ?key|credential/i.test(description)
        ? `${this.serviceLabel} rejected the configured API key`
        : `${this.serviceLabel} request failed: ${description || 'unknown error'}`);
    }
    if (!/<caps/i.test(text)) {
      throw new Error(`${this.serviceLabel} did not answer with torznab caps - check the URL`);
    }
    try {
      const { data } = await this.http.get('/api/v2.0/server/config', { params: { apikey: this.apiKey } });
      return { version: data?.app_version || null };
    } catch (err) {
      return { version: null };
    }
  }

  async getQueue() {
    return [];
  }

  // EVERY CONFIGURED INDEXER QUERIED AT ONCE - THE JSON AGGREGATE ENDPOINT.
  // BEST SEEDED FIRST; DEAD RESULTS (0 SEEDERS, NO LINK) DROP OUT.
  async searchReleases(term) {
    let data;
    try {
      ({ data } = await this.http.get('/api/v2.0/indexers/all/results', {
        params: { apikey: this.apiKey, Query: term }
      }));
    } catch (err) {
      throw this._normalizeError(err);
    }
    return (data?.Results || [])
      .map(raw => ({
        id: String(raw.Guid || raw.Link || raw.Title),
        title: raw.Title || 'Unknown',
        indexer: raw.Tracker || null,
        category: raw.CategoryDesc || null,
        protocol: 'torrent',
        size: Number(raw.Size) || null,
        sizeHuman: BaseClient.humanSize(raw.Size),
        seeders: typeof raw.Seeders === 'number' ? raw.Seeders : null,
        age: BaseClient.humanAge(raw.PublishDate),
        ageMinutes: BaseClient.ageMinutes(raw.PublishDate),
        downloadUrl: raw.MagnetUri || raw.Link || null,
        raw
      }))
      .filter(release => release.downloadUrl)
      .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  }

  // CONFIGURED INDEXER ROSTER - null WHEN THE ADMIN API IS LOCKED AWAY, THE
  // RELEASES SURFACE JUST SKIPS THE LIST
  async getIndexers() {
    try {
      const { data } = await this.http.get('/api/v2.0/indexers', {
        params: { apikey: this.apiKey, configured: 'true' }
      });
      if (!Array.isArray(data)) return null;
      return data.map(indexer => ({
        id: String(indexer.id),
        name: indexer.name || indexer.id,
        kind: indexer.type || null,
        error: indexer.last_error || null
      }));
    } catch (err) {
      this.logger?.debug(`${this.serviceLabel} indexer roster unavailable: ${err.message}`);
      return null;
    }
  }

  // INDEXERS CARRYING A LAST ERROR SURFACE AS OVERVIEW HEALTH WARNINGS
  async getHealth() {
    const indexers = await this.getIndexers();
    return (indexers || [])
      .filter(indexer => indexer.error)
      .map(indexer => ({ type: 'warning', message: `${indexer.name}: ${indexer.error}` }));
  }

  get capabilities() {
    return {
      ...super.capabilities,
      search: true,
      releases: true,
      health: true
    };
  }
}

module.exports = JackettClient;
