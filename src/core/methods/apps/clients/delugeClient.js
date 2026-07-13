const axios = require('axios');
const BaseClient = require('./baseClient');

// WEB SESSION COOKIES KEYED BY APP-INSTANCE ID - SAME SURVIVING-SESSION
// PATTERN AS qbittorrentClient (CLIENTS ARE BUILT PER-USE)
const SESSIONS = new Map();

const STATE_LABELS = {
  Downloading: 'downloading',
  Seeding: 'seeding',
  Paused: 'paused',
  Queued: 'queued',
  Checking: 'checking',
  Allocating: 'allocating',
  Moving: 'moving',
  Error: 'error'
};

const TORRENT_FIELDS = [
  'name', 'state', 'progress', 'eta', 'total_size', 'total_done',
  'download_payload_rate', 'num_seeds', 'total_seeds', 'time_added',
  'completed_time', 'message'
];

// DELUGE WEB JSON-RPC (/json) - PASSWORD LOGIN SETS A _session_id COOKIE, AND
// THE WEB UI MUST BE CONNECTED TO A DAEMON BEFORE core.* CALLS MEAN ANYTHING
class DelugeClient extends BaseClient {
  constructor({ url, password, logger, cacheKey }) {
    super({ url, logger });
    this.serviceLabel = 'Deluge';
    this.password = password;
    this.cacheKey = cacheKey || this.baseUrl;
    this._rpcId = 0;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
  }

  _fingerprint() {
    return `${this.baseUrl}|${this.password}`;
  }

  async _rawCall(method, params, cookie) {
    try {
      return await this.http.post('/json', { method, params, id: ++this._rpcId }, {
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }
      });
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async _authedCall(method, params, cookie) {
    const res = await this._rawCall(method, params, cookie);
    if (res.data?.error) {
      throw new Error(`${this.serviceLabel} request failed: ${res.data.error.message || res.data.error.code}`);
    }
    return res.data?.result;
  }

  async _login() {
    const res = await this._rawCall('auth.login', [this.password || '']);
    if (!res.data?.result) throw new Error(`${this.serviceLabel} rejected the configured password`);
    const setCookie = res.headers['set-cookie'] || [];
    const cookie = setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('_session_id='));
    if (!cookie) throw new Error(`${this.serviceLabel} login did not return a session cookie`);

    // A LOGGED-IN WEB UI CAN STILL BE DISCONNECTED FROM EVERY DAEMON
    const connected = await this._authedCall('web.connected', [], cookie);
    if (!connected) {
      const hosts = await this._authedCall('web.get_hosts', [], cookie);
      if (!hosts || !hosts.length) {
        throw new Error(`${this.serviceLabel} has no daemon configured in its web UI`);
      }
      await this._authedCall('web.connect', [hosts[0][0]], cookie);
    }

    SESSIONS.set(this.cacheKey, { cookie, fingerprint: this._fingerprint() });
    return cookie;
  }

  async _call(method, params = [], retried = false) {
    const cached = SESSIONS.get(this.cacheKey);
    const cookie = cached && cached.fingerprint === this._fingerprint()
      ? cached.cookie
      : await this._login();
    const res = await this._rawCall(method, params, cookie);
    const error = res.data?.error;
    if (error) {
      // CODE 1 = NOT AUTHENTICATED - THE SESSION EXPIRED, LOG IN AGAIN ONCE
      if (error.code === 1 && !retried) {
        SESSIONS.delete(this.cacheKey);
        return this._call(method, params, true);
      }
      throw new Error(`${this.serviceLabel} request failed: ${error.message || error.code}`);
    }
    return res.data?.result;
  }

  // DELUGE 2 ANSWERS daemon.get_version; 1.x ONLY KNOWS daemon.info
  async getStatus() {
    try {
      return { version: String(await this._call('daemon.get_version')) };
    } catch (err) {
      return { version: String(await this._call('daemon.info')) };
    }
  }

  // "QUEUE" = TORRENTS STILL FETCHING DATA, LIKE THE OTHER TORRENT CLIENTS
  async getQueue() {
    const ui = await this._call('web.update_ui', [TORRENT_FIELDS, {}]);
    return Object.entries(ui?.torrents || {})
      .filter(([, torrent]) => (torrent.progress || 0) < 100)
      .map(([hash, torrent]) => {
        const size = torrent.total_size || null;
        const sizeleft = size ? size - (torrent.total_done || 0) : null;
        return {
          id: hash,
          title: torrent.name || 'Unknown',
          subtitle: null,
          status: STATE_LABELS[torrent.state] || (torrent.state || 'queued').toLowerCase(),
          percent: BaseClient.clampPercent(torrent.progress || 0),
          timeleft: BaseClient.humanEta(torrent.eta),
          size,
          sizeleft,
          sizeHuman: BaseClient.humanSize(size),
          sizeleftHuman: BaseClient.humanSize(sizeleft),
          quality: null,
          protocol: 'torrent',
          downloadClient: null,
          indexer: null,
          category: null,
          speed: torrent.download_payload_rate > 0 ? BaseClient.humanSpeed(torrent.download_payload_rate) : null,
          seeds: typeof torrent.num_seeds === 'number' ? `${torrent.num_seeds}/${torrent.total_seeds ?? 0}` : null,
          warnings: torrent.message && torrent.message !== 'OK' ? [torrent.message] : [],
          raw: { ...torrent, hash }
        };
      });
  }

  // NORMALIZED FEED ROWS - DELUGE HAS NO HISTORY ENDPOINT, SO COMPLETED
  // TORRENTS ARE SORTED AND SLICED CLIENT-SIDE
  async getHistory(page = 1, pageSize = 15) {
    const ui = await this._call('web.update_ui', [TORRENT_FIELDS, {}]);
    const finishedAt = torrent => torrent.completed_time || torrent.time_added || 0;
    const done = Object.entries(ui?.torrents || {})
      .filter(([, torrent]) => (torrent.progress || 0) >= 100)
      .sort((a, b) => finishedAt(b[1]) - finishedAt(a[1]));
    const start = (page - 1) * pageSize;
    const slice = done.slice(start, start + pageSize);
    return {
      rows: slice.map(([hash, torrent]) => ({
        id: hash,
        kind: 'completed',
        title: torrent.name || 'Unknown',
        detail: BaseClient.humanSize(torrent.total_size),
        at: finishedAt(torrent) ? new Date(finishedAt(torrent) * 1000).toISOString() : null
      })),
      hasMore: done.length > start + slice.length
    };
  }

  // NULL id TARGETS THE WHOLE SESSION; remove KEEPS DOWNLOADED DATA ON DISK
  async queueAction(verb, id = null) {
    if (verb === 'pause' || verb === 'resume') {
      if (id) return this._call(verb === 'pause' ? 'core.pause_torrent' : 'core.resume_torrent', [[id]]);
      try {
        return await this._call(verb === 'pause' ? 'core.pause_session' : 'core.resume_session');
      } catch (err) {
        // OLDER DAEMONS ONLY KNOW THE *_all_torrents NAMES
        return this._call(verb === 'pause' ? 'core.pause_all_torrents' : 'core.resume_all_torrents');
      }
    }
    if (verb === 'remove' && id) return this._call('core.remove_torrent', [id, false]);
    throw new Error(`${this.serviceLabel} cannot '${verb}' a queue item`);
  }

  async addDownload(url) {
    return /^magnet:/i.test(url)
      ? this._call('core.add_torrent_magnet', [url, {}])
      : this._call('core.add_torrent_url', [url, {}]);
  }

  get capabilities() {
    return {
      ...super.capabilities,
      addByUrl: true,
      queueActions: { item: ['pause', 'resume', 'remove'], queue: ['pause', 'resume'] }
    };
  }
}

module.exports = DelugeClient;
