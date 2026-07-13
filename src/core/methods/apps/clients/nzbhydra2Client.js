const axios = require('axios');
const BaseClient = require('./baseClient');

// HYDRA'S NEWZNAB JSON WRAPS VALUES IN @attributes BLOCKS - UNWRAP EITHER SHAPE
function attributesOf(entry) {
  return entry && entry['@attributes'] ? entry['@attributes'] : entry || {};
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// NZBHYDRA2 - NEWZNAB CAPS AS THE APIKEY-GATED CONNECTIVITY CHECK; THE
// <server> TAG CARRIES THE APP VERSION WHEN HYDRA FEELS LIKE SHARING.
// RELEASE SEARCH RIDES THE NEWZNAB JSON OUTPUT (EVERY WRAPPED INDEXER AT
// ONCE); GRABS HAND THE RESULT LINK TO A CONNECTED DOWNLOAD CLIENT.
class Nzbhydra2Client extends BaseClient {
  constructor({ url, apiKey, logger }) {
    super({ url, logger });
    this.serviceLabel = 'NZBHydra2';
    this.apiKey = apiKey;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 30000 });
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

  // META SEARCH ACROSS EVERY WRAPPED INDEXER - NEWZNAB t=search WITH o=json.
  // HYDRA TAGS EACH ITEM WITH ITS SOURCE INDEXER AND DOWNLOAD TYPE ATTRS.
  async searchReleases(term) {
    let data;
    try {
      ({ data } = await this.http.get('/api', {
        params: { apikey: this.apiKey, t: 'search', q: term, o: 'json', limit: 100 }
      }));
    } catch (err) {
      throw this._normalizeError(err);
    }
    if (typeof data === 'string' && /<error/i.test(data)) {
      const description = data.match(/description="([^"]*)"/)?.[1] || 'unknown error';
      throw new Error(`${this.serviceLabel} request failed: ${description}`);
    }
    const items = asArray(data?.channel?.item);
    return items.map(item => {
      const attrs = {};
      for (const entry of asArray(item.attr)) {
        const attribute = attributesOf(entry);
        if (attribute.name) attrs[String(attribute.name).toLowerCase()] = attribute.value;
      }
      const enclosure = attributesOf(item.enclosure);
      const size = Number(attrs.size) || Number(enclosure.length) || null;
      const torrent = String(attrs.downloadtype || '').toLowerCase().includes('torrent');
      return {
        id: String(attrs.guid || item.link || item.title),
        title: item.title || 'Unknown',
        indexer: attrs.hydraindexername || attrs.indexer || null,
        category: attrs.category || null,
        protocol: torrent ? 'torrent' : 'usenet',
        size,
        sizeHuman: BaseClient.humanSize(size),
        seeders: attrs.seeders != null ? Number(attrs.seeders) : null,
        age: BaseClient.humanAge(item.pubDate),
        downloadUrl: enclosure.url || item.link || null,
        raw: item
      };
    }).filter(release => release.downloadUrl);
  }

  get capabilities() {
    return {
      ...super.capabilities,
      search: true,
      releases: true
    };
  }
}

module.exports = Nzbhydra2Client;
