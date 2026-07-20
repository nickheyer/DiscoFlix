const axios = require('axios');
const BaseClient = require('./baseClient');
const tuning = require('../../../tuning');

// SID SESSION CACHE, KEYED BY APP-INSTANCE ID. CLIENTS ARE BUILT PER-USE
// (SETTINGS APPLY IMMEDIATELY) BUT THE LOGIN SESSION SURVIVES ACROSS BUILDS;
// THE FINGERPRINT INVALIDATES A CACHED SID WHEN CREDENTIALS CHANGE.
const SESSIONS = new Map();

const STATE_LABELS = {
  downloading: 'downloading',
  forcedDL: 'downloading',
  metaDL: 'fetching metadata',
  stalledDL: 'stalled',
  queuedDL: 'queued',
  pausedDL: 'paused',
  stoppedDL: 'paused',
  allocating: 'allocating',
  checkingDL: 'checking',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  error: 'error',
  missingFiles: 'missing files',
  moving: 'moving'
};

// QBIT REPORTS ETA 8640000 (100 DAYS) AS "INFINITE"
function formatEta(seconds) {
  const num = Number(seconds);
  if (isNaN(num) || num >= 8640000) return null;
  return BaseClient.humanEta(num);
}

// QBITTORRENT WEBUI API v2 - COOKIE-SESSION AUTH (POST /auth/login -> SID)
class QbittorrentClient extends BaseClient {
  constructor({ url, username, password, logger, cacheKey }) {
    super({ url, logger });
    this.serviceLabel = 'qBittorrent';
    this.username = username;
    this.password = password;
    this.cacheKey = cacheKey || this.baseUrl;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: tuning.value('download_client_http_timeout_seconds') * 1000,
      // QBIT REJECTS LOGINS WITHOUT A MATCHING Referer (CSRF PROTECTION)
      headers: { Referer: this.baseUrl }
    });
  }

  _fingerprint() {
    return `${this.baseUrl}|${this.username}|${this.password}`;
  }

  async _login() {
    let res;
    try {
      res = await this.http.post(
        '/api/v2/auth/login',
        new URLSearchParams({
          username: this.username || '',
          password: this.password || ''
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch (err) {
      throw this._normalizeError(err);
    }
    if (typeof res.data === 'string' && /fails/i.test(res.data)) {
      throw new Error(`${this.serviceLabel} rejected the configured username/password`);
    }
    const setCookie = res.headers['set-cookie'] || [];
    const sid = setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('SID='));
    if (!sid) throw new Error(`${this.serviceLabel} login did not return a session cookie`);
    SESSIONS.set(this.cacheKey, { sid, fingerprint: this._fingerprint() });
    return sid;
  }

  async _ensureSession() {
    const cached = SESSIONS.get(this.cacheKey);
    if (cached && cached.fingerprint === this._fingerprint()) return cached.sid;
    return this._login();
  }

  async _request(path, params = {}, retried = false) {
    const sid = await this._ensureSession();
    try {
      const { data } = await this.http.get(path, { params, headers: { Cookie: sid } });
      return data;
    } catch (err) {
      // STALE/REVOKED SID → RE-LOGIN AND RETRY EXACTLY ONCE
      if (err.response?.status === 403 && !retried) {
        SESSIONS.delete(this.cacheKey);
        return this._request(path, params, true);
      }
      throw this._normalizeError(err);
    }
  }

  async _post(path, form = {}, retried = false) {
    const sid = await this._ensureSession();
    try {
      const { data } = await this.http.post(path, new URLSearchParams(form).toString(), {
        headers: { Cookie: sid, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      return data;
    } catch (err) {
      // STALE/REVOKED SID → RE-LOGIN AND RETRY EXACTLY ONCE
      if (err.response?.status === 403 && !retried) {
        SESSIONS.delete(this.cacheKey);
        return this._post(path, form, true);
      }
      throw this._normalizeError(err);
    }
  }

  async getStatus() {
    const version = await this._request('/api/v2/app/version');
    return { version: String(version).replace(/^v/, '') };
  }

  // "QUEUE" = TORRENTS STILL FETCHING DATA; SEEDING/COMPLETED LIVE IN HISTORY
  async getQueue() {
    const torrents = await this._request('/api/v2/torrents/info');
    return (torrents || [])
      .filter(torrent => torrent.progress < 1)
      .map(torrent => ({
        id: torrent.hash,
        title: torrent.name || 'Unknown',
        subtitle: null,
        status: STATE_LABELS[torrent.state] || torrent.state || 'queued',
        percent: BaseClient.clampPercent(torrent.progress * 100),
        timeleft: formatEta(torrent.eta),
        size: torrent.size || null,
        sizeleft: torrent.amount_left ?? null,
        sizeHuman: BaseClient.humanSize(torrent.size),
        sizeleftHuman: BaseClient.humanSize(torrent.amount_left),
        quality: null,
        protocol: 'torrent',
        downloadClient: null,
        indexer: null,
        category: torrent.category || null,
        speed: torrent.dlspeed > 0 ? BaseClient.humanSpeed(torrent.dlspeed) : null,
        speedBps: torrent.dlspeed > 0 ? torrent.dlspeed : null,
        seeds: typeof torrent.num_seeds === 'number' ? `${torrent.num_seeds}/${torrent.num_leechs ?? 0}` : null,
        warnings: torrent.state === 'missingFiles' ? ['Files are missing on disk'] : [],
        raw: torrent
      }));
  }

  // NORMALIZED FEED ROWS (SEE baseClient CONTRACT) - QBIT HAS NO PAGED HISTORY
  // ENDPOINT, SO COMPLETED TORRENTS ARE SORTED AND SLICED CLIENT-SIDE
  async getHistory(page = 1, pageSize = 15) {
    const torrents = await this._request('/api/v2/torrents/info', { filter: 'completed' });
    const sorted = (torrents || []).sort((a, b) => (b.completion_on || 0) - (a.completion_on || 0));
    const start = (page - 1) * pageSize;
    const slice = sorted.slice(start, start + pageSize);
    return {
      rows: slice.map(torrent => ({
        id: torrent.hash,
        kind: 'completed',
        title: torrent.name || 'Unknown',
        detail: [torrent.category, BaseClient.humanSize(torrent.size)].filter(Boolean).join(' • ') || null,
        at: torrent.completion_on > 0 ? new Date(torrent.completion_on * 1000).toISOString() : null
      })),
      hasMore: sorted.length > start + slice.length
    };
  }

  // NULL id TARGETS EVERY TORRENT, remove KEEPS THE DOWNLOADED FILES ON DISK
  async queueAction(verb, id = null) {
    const hashes = id || 'all';
    if (verb === 'pause' || verb === 'resume') {
      try {
        return await this._post(`/api/v2/torrents/${verb}`, { hashes });
      } catch (err) {
        // qBIT 5 RENAMED pause/resume TO stop/start - FALL BACK ON 404
        if (err.cause?.response?.status !== 404) throw err;
        return this._post(`/api/v2/torrents/${verb === 'pause' ? 'stop' : 'start'}`, { hashes });
      }
    }
    if (verb === 'remove' && id) {
      return this._post('/api/v2/torrents/delete', { hashes, deleteFiles: false });
    }
    throw new Error(`${this.serviceLabel} cannot '${verb}' a queue item`);
  }

  async addDownload(url) {
    const data = await this._post('/api/v2/torrents/add', { urls: url });
    if (typeof data === 'string' && /fail/i.test(data)) {
      throw new Error(`${this.serviceLabel} did not accept that link`);
    }
    return data;
  }

  get capabilities() {
    return {
      ...super.capabilities,
      addByUrl: true,
      queueActions: { item: ['pause', 'resume', 'remove'], queue: ['pause', 'resume'] }
    };
  }
}

module.exports = QbittorrentClient;
