const axios = require('axios');
const BaseClient = require('./baseClient');

// TOKEN + GUID COOKIE SESSIONS KEYED BY APP-INSTANCE ID
const SESSIONS = new Map();

// LIST ROW COLUMNS (WEBUI API v1) - LATER BUILDS APPEND DATE COLUMNS
const COL = {
  HASH: 0,
  STATUS: 1,
  NAME: 2,
  SIZE: 3,
  PROGRESS_PERMILLE: 4,
  UP_SPEED: 8,
  DOWN_SPEED: 9,
  ETA: 10,
  LABEL: 11,
  SEEDS_CONNECTED: 14,
  SEEDS_SWARM: 15,
  REMAINING: 18,
  DATE_ADDED: 23,
  DATE_COMPLETED: 24
};

// STATUS BITFIELD: 1 STARTED, 2 CHECKING, 16 ERROR, 32 PAUSED, 64 QUEUED
function statusLabel(bits, permille) {
  if (bits & 16) return 'error';
  if (bits & 2) return 'checking';
  if (bits & 32) return 'paused';
  if (bits & 1) return permille >= 1000 ? 'seeding' : 'downloading';
  if (bits & 64) return 'queued';
  return 'paused';
}

// UTORRENT WEBUI - BASIC AUTH PLUS THE token.html CSRF TOKEN (AND ITS GUID
// COOKIE, WHICH MUST RIDE ALONG OR THE TOKEN IS WORTHLESS)
class UtorrentClient extends BaseClient {
  constructor({ url, username, password, logger, cacheKey }) {
    super({ url, logger });
    this.serviceLabel = 'uTorrent';
    this.username = username;
    this.password = password;
    this.cacheKey = cacheKey || this.baseUrl;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      auth: { username: username || '', password: password || '' }
    });
  }

  _fingerprint() {
    return `${this.baseUrl}|${this.username}|${this.password}`;
  }

  async _login() {
    let res;
    try {
      res = await this.http.get('/gui/token.html');
    } catch (err) {
      throw this._normalizeError(err);
    }
    const token = String(res.data).match(/<div[^>]*id=['"]token['"][^>]*>([^<]+)<\/div>/)?.[1];
    if (!token) throw new Error(`${this.serviceLabel} did not hand out a WebUI token`);
    const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('GUID='));
    const session = { token, cookie: cookie || null, fingerprint: this._fingerprint() };
    SESSIONS.set(this.cacheKey, session);
    return session;
  }

  async _call(params, retried = false) {
    let session = SESSIONS.get(this.cacheKey);
    if (!session || session.fingerprint !== this._fingerprint()) session = await this._login();
    try {
      const { data } = await this.http.get('/gui/', {
        params: { token: session.token, ...params },
        headers: session.cookie ? { Cookie: session.cookie } : {}
      });
      return data;
    } catch (err) {
      // 400 = STALE TOKEN - MINT A FRESH ONE AND RETRY EXACTLY ONCE
      if (err.response?.status === 400 && !retried) {
        SESSIONS.delete(this.cacheKey);
        return this._call(params, true);
      }
      throw this._normalizeError(err);
    }
  }

  async getStatus() {
    const data = await this._call({ list: 1 });
    return { version: data?.build ? String(data.build) : null };
  }

  async getQueue() {
    const data = await this._call({ list: 1 });
    return (data?.torrents || [])
      .filter(row => (row[COL.PROGRESS_PERMILLE] || 0) < 1000)
      .map(row => {
        const size = row[COL.SIZE] || null;
        const permille = row[COL.PROGRESS_PERMILLE] || 0;
        const remaining = row[COL.REMAINING] ?? (size ? Math.round(size * (1 - permille / 1000)) : null);
        const rate = row[COL.DOWN_SPEED] || 0;
        return {
          id: String(row[COL.HASH]),
          title: row[COL.NAME] || 'Unknown',
          subtitle: null,
          status: statusLabel(row[COL.STATUS] || 0, permille),
          percent: BaseClient.clampPercent(permille / 10),
          timeleft: BaseClient.humanEta(row[COL.ETA]),
          size,
          sizeleft: remaining,
          sizeHuman: BaseClient.humanSize(size),
          sizeleftHuman: BaseClient.humanSize(remaining),
          quality: null,
          protocol: 'torrent',
          downloadClient: null,
          indexer: null,
          category: row[COL.LABEL] || null,
          speed: rate > 0 ? BaseClient.humanSpeed(rate) : null,
          seeds: typeof row[COL.SEEDS_CONNECTED] === 'number' ? `${row[COL.SEEDS_CONNECTED]}/${row[COL.SEEDS_SWARM] ?? 0}` : null,
          warnings: [],
          raw: row
        };
      });
  }

  // NORMALIZED FEED ROWS - COMPLETED TORRENTS, NEWEST FIRST WHEN THE BUILD
  // REPORTS DATE COLUMNS
  async getHistory(page = 1, pageSize = 15) {
    const data = await this._call({ list: 1 });
    const finishedAt = row => Number(row[COL.DATE_COMPLETED]) || Number(row[COL.DATE_ADDED]) || 0;
    const done = (data?.torrents || [])
      .filter(row => (row[COL.PROGRESS_PERMILLE] || 0) >= 1000)
      .sort((a, b) => finishedAt(b) - finishedAt(a));
    const start = (page - 1) * pageSize;
    const slice = done.slice(start, start + pageSize);
    return {
      rows: slice.map(row => {
        const detail = [
          row[COL.LABEL] || null,
          BaseClient.humanSize(row[COL.SIZE])
        ].filter(Boolean).join(' • ');
        return {
          id: String(row[COL.HASH]),
          kind: 'completed',
          title: row[COL.NAME] || 'Unknown',
          detail: detail || null,
          at: finishedAt(row) ? new Date(finishedAt(row) * 1000).toISOString() : null
        };
      }),
      hasMore: done.length > start + slice.length
    };
  }

  // start RESUMES PAUSED AND STOPPED ALIKE; remove KEEPS DATA ON DISK
  async queueAction(verb, id = null) {
    if (!id) throw new Error(`${this.serviceLabel} cannot '${verb}' the whole queue`);
    const actions = { pause: 'pause', resume: 'start', remove: 'remove' };
    if (!actions[verb]) throw new Error(`${this.serviceLabel} cannot '${verb}' a queue item`);
    return this._call({ action: actions[verb], hash: id });
  }

  get capabilities() {
    return {
      search: false,
      add: false,
      library: false,
      libraryDetail: false,
      health: false,
      queueActions: { item: ['pause', 'resume', 'remove'], queue: [] }
    };
  }
}

module.exports = UtorrentClient;
