const axios = require('axios');
const BaseClient = require('./baseClient');

// EMBY (AND JELLYFIN, WHICH KEPT THE API SHAPE) - X-Emby-Token AUTH,
// /System/Info FOR STATUS, LATEST ITEMS AS THE ACTIVITY FEED. NO QUEUE.
class EmbyClient extends BaseClient {
  constructor({ url, apiKey, logger }) {
    super({ url, logger });
    this.serviceLabel = 'Emby';
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: { 'X-Emby-Token': apiKey }
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

  async getStatus() {
    const info = await this._get('/System/Info');
    return { version: info?.Version || null };
  }

  async getQueue() {
    return [];
  }

  // NORMALIZED FEED ROWS - NEWEST LIBRARY ADDITIONS, NATIVELY PAGED
  async getHistory(page = 1, pageSize = 15) {
    const start = (page - 1) * pageSize;
    const data = await this._get('/Items', {
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Recursive: true,
      IncludeItemTypes: 'Movie,Episode',
      StartIndex: start,
      Limit: pageSize,
      Fields: 'DateCreated,ProductionYear'
    });
    const items = data?.Items || [];
    const total = data?.TotalRecordCount ?? (start + items.length);
    return {
      rows: items.map(item => ({
        id: String(item.Id),
        kind: 'added',
        title: item.SeriesName ? `${item.SeriesName} - ${item.Name}` : (item.Name || 'Unknown'),
        detail: [
          item.Type || null,
          item.ProductionYear || null
        ].filter(Boolean).join(' • ') || null,
        at: item.DateCreated || null
      })),
      hasMore: start + items.length < total
    };
  }
}

module.exports = EmbyClient;
