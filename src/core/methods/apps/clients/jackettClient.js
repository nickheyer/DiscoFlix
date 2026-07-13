const axios = require('axios');
const BaseClient = require('./baseClient');

// JACKETT - THE TORZNAB CAPS FEED IS THE AUTHORITATIVE APIKEY-GATED
// CONNECTIVITY CHECK; THE ADMIN CONFIG ENDPOINT ADDS A VERSION WHEN IT
// ISN'T LOCKED BEHIND THE ADMIN PASSWORD
class JackettClient extends BaseClient {
  constructor({ url, apiKey, logger }) {
    super({ url, logger });
    this.serviceLabel = 'Jackett';
    this.apiKey = apiKey;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
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
}

module.exports = JackettClient;
