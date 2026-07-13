const axios = require('axios');
const BaseClient = require('./baseClient');

// PLEX MEDIA SERVER - X-Plex-Token AUTH, JSON VIA THE Accept HEADER. NO
// DOWNLOAD QUEUE; THE ACTIVITY FEED IS THE RECENTLY ADDED SHELF.
class PlexClient extends BaseClient {
  constructor({ url, token, logger }) {
    super({ url, logger });
    this.serviceLabel = 'Plex';
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: { 'X-Plex-Token': token, Accept: 'application/json' }
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

  // THE SERVER ROOT REQUIRES A VALID TOKEN AND CARRIES THE VERSION - EXACTLY
  // THE CONNECTIVITY PROOF A STATUS CHECK WANTS
  async getStatus() {
    const data = await this._get('/');
    return { version: data?.MediaContainer?.version || null };
  }

  async getQueue() {
    return [];
  }

  // NORMALIZED FEED ROWS - PLEX PAGES VIA THE CONTAINER START/SIZE PARAMS
  async getHistory(page = 1, pageSize = 15) {
    const start = (page - 1) * pageSize;
    const data = await this._get('/library/recentlyAdded', {
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': pageSize
    });
    const container = data?.MediaContainer || {};
    const items = container.Metadata || [];
    const total = container.totalSize ?? (start + items.length);
    return {
      rows: items.map(item => ({
        id: String(item.ratingKey || item.key),
        kind: 'added',
        title: item.grandparentTitle ? `${item.grandparentTitle} - ${item.title}` : (item.title || 'Unknown'),
        detail: [
          item.type ? item.type.charAt(0).toUpperCase() + item.type.slice(1) : null,
          item.year || null
        ].filter(Boolean).join(' • ') || null,
        at: item.addedAt ? new Date(item.addedAt * 1000).toISOString() : null
      })),
      hasMore: start + items.length < total
    };
  }
}

module.exports = PlexClient;
