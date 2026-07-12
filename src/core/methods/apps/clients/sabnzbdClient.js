const axios = require('axios');
const BaseClient = require('./baseClient');

const MB = 1024 * 1024;

function mbToBytes(mb) {
  const num = Number(mb);
  return isNaN(num) || num <= 0 ? null : Math.round(num * MB);
}

// SABNZBD JSON API — SINGLE /api ENDPOINT, mode= SELECTS THE OPERATION.
// SAB ANSWERS HTTP 200 EVEN FOR A BAD API KEY ({ status: false, error }), SO
// APPLICATION-LEVEL FAILURES ARE DETECTED AND RETHROWN AS NORMALIZED ERRORS.
class SabnzbdClient extends BaseClient {
  constructor({ url, apiKey, logger }) {
    super({ url, logger });
    this.serviceLabel = 'SABnzbd';
    this.apiKey = apiKey;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
  }

  async _call(mode, params = {}) {
    let data;
    try {
      ({ data } = await this.http.get('/api', {
        params: { output: 'json', apikey: this.apiKey, mode, ...params }
      }));
    } catch (err) {
      throw this._normalizeError(err);
    }
    if (data && data.status === false) {
      const message = String(data.error || 'unknown error');
      throw new Error(/api ?key/i.test(message)
        ? `${this.serviceLabel} rejected the configured API key`
        : `${this.serviceLabel} request failed: ${message}`);
    }
    return data;
  }

  async getStatus() {
    const data = await this._call('version');
    return { version: data.version };
  }

  async getQueue() {
    const data = await this._call('queue');
    const slots = data.queue?.slots || [];
    return slots.map(slot => ({
      id: slot.nzo_id,
      title: slot.filename || 'Unknown',
      status: (slot.status || 'queued').toLowerCase(),
      percent: BaseClient.clampPercent(slot.percentage),
      timeleft: slot.timeleft && slot.timeleft !== '0:00:00' ? slot.timeleft : null,
      size: mbToBytes(slot.mb),
      sizeleft: mbToBytes(slot.mbleft),
      raw: slot
    }));
  }

  // NORMALIZED FEED ROWS (SEE baseClient CONTRACT) — SAB PAGES VIA start/limit
  async getHistory(page = 1, pageSize = 15) {
    const start = (page - 1) * pageSize;
    const data = await this._call('history', { start, limit: pageSize });
    const history = data.history || {};
    const slots = history.slots || [];
    return {
      rows: slots.map(slot => {
        const failed = /fail/i.test(slot.status || '');
        const detail = [
          slot.category && slot.category !== '*' ? slot.category : null,
          BaseClient.humanSize(slot.bytes)
        ].filter(Boolean).join(' • ');
        return {
          id: slot.nzo_id,
          kind: failed ? 'failed' : 'completed',
          title: slot.name || 'Unknown',
          detail: (failed && slot.fail_message) || detail || null,
          at: slot.completed ? new Date(slot.completed * 1000).toISOString() : null
        };
      }),
      hasMore: start + slots.length < (history.noofslots || 0)
    };
  }

  async pauseQueue() {
    return this._call('pause');
  }

  async resumeQueue() {
    return this._call('resume');
  }

  get capabilities() {
    return { search: false, add: false, library: false, health: false, pauseResume: true };
  }
}

module.exports = SabnzbdClient;
