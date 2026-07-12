const axios = require('axios');
const BaseClient = require('./baseClient');

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
  if (isNaN(num) || num <= 0 || num >= 8640000) return null;
  const hours = Math.floor(num / 3600);
  const minutes = Math.floor((num % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// QBITTORRENT WEBUI API v2 — COOKIE-SESSION AUTH (POST /auth/login -> SID)
class QbittorrentClient extends BaseClient {
  constructor({ url, username, password, logger, cacheKey }) {
    super({ url, logger });
    this.serviceLabel = 'qBittorrent';
    this.username = username;
    this.password = password;
    this.cacheKey = cacheKey || this.baseUrl;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
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
        status: STATE_LABELS[torrent.state] || torrent.state || 'queued',
        percent: BaseClient.clampPercent(torrent.progress * 100),
        timeleft: formatEta(torrent.eta),
        size: torrent.size || null,
        sizeleft: torrent.amount_left ?? null,
        raw: torrent
      }));
  }

  async getHistory(limit = 30) {
    const torrents = await this._request('/api/v2/torrents/info', { filter: 'completed' });
    return (torrents || [])
      .sort((a, b) => (b.completion_on || 0) - (a.completion_on || 0))
      .slice(0, limit)
      .map(torrent => ({
        id: torrent.hash,
        title: torrent.name || 'Unknown',
        status: 'completed',
        size: torrent.size || null,
        category: torrent.category || null,
        completedAt: torrent.completion_on > 0 ? new Date(torrent.completion_on * 1000) : null,
        failMessage: null,
        raw: torrent
      }));
  }

  async getTransferInfo() {
    return this._request('/api/v2/transfer/info');
  }

  get capabilities() {
    return { search: false, add: false, library: false, health: false, pauseResume: true };
  }
}

module.exports = QbittorrentClient;
