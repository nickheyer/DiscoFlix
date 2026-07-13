const axios = require('axios');
const BaseClient = require('./baseClient');

// NZBHYDRA2 - NEWZNAB CAPS AS THE APIKEY-GATED CONNECTIVITY CHECK; THE
// <server> TAG CARRIES THE APP VERSION WHEN HYDRA FEELS LIKE SHARING
class Nzbhydra2Client extends BaseClient {
  constructor({ url, apiKey, logger }) {
    super({ url, logger });
    this.serviceLabel = 'NZBHydra2';
    this.apiKey = apiKey;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
  }

  async getStatus() {
    let caps;
    try {
      ({ data: caps } = await this.http.get('/api', { params: { apikey: this.apiKey, t: 'caps' } }));
    } catch (err) {
      throw this._normalizeError(err);
    }
    const text = String(caps);
    if (/<error/i.test(text)) {
      const description = text.match(/description="([^"]*)"/)?.[1] || '';
      throw new Error(/api ?key|credential|wrong api/i.test(description)
        ? `${this.serviceLabel} rejected the configured API key`
        : `${this.serviceLabel} request failed: ${description || 'unknown error'}`);
    }
    if (!/<caps/i.test(text)) {
      throw new Error(`${this.serviceLabel} did not answer with newznab caps - check the URL`);
    }
    const version = text.match(/<server[^>]*\bappversion="([^"]+)"/i)?.[1]
      || text.match(/<server[^>]*\bversion="([^"]+)"/i)?.[1]
      || null;
    return { version };
  }

  async getQueue() {
    return [];
  }
}

module.exports = Nzbhydra2Client;
