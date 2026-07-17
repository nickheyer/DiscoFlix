const axios = require('axios');
const BaseClient = require('./baseClient');

// CSRF SESSION IDS KEYED BY APP-INSTANCE ID - THE 409 HANDSHAKE RUNS ONCE,
// NOT ONCE PER CLIENT BUILD
const SESSIONS = new Map();

// RPC STATUS CODES (SPEC: 0 STOPPED .. 6 SEEDING)
const STATUS_LABELS = {
  0: 'paused',
  1: 'queued to check',
  2: 'checking',
  3: 'queued',
  4: 'downloading',
  5: 'queued to seed',
  6: 'seeding'
};

const TORRENT_FIELDS = [
  'id', 'name', 'status', 'percentDone', 'eta', 'totalSize', 'leftUntilDone',
  'rateDownload', 'peersSendingToUs', 'peersConnected', 'errorString',
  'doneDate', 'addedDate'
];

// TRANSMISSION RPC AT /transmission/rpc - OPTIONAL BASIC AUTH PLUS THE
// X-Transmission-Session-Id CSRF HANDSHAKE (A 409 CARRIES THE FRESH ID)
class TransmissionClient extends BaseClient {
  constructor({ url, username, password, logger, cacheKey }) {
    super({ url, logger });
    this.serviceLabel = 'Transmission';
    this.cacheKey = cacheKey || this.baseUrl;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      auth: username || password ? { username: username || '', password: password || '' } : undefined
    });
  }

  async _rpc(method, args = {}, retried = false) {
    let res;
    try {
      res = await this.http.post('/transmission/rpc', { method, arguments: args }, {
        headers: { 'X-Transmission-Session-Id': SESSIONS.get(this.cacheKey) || '' }
      });
    } catch (err) {
      if (err.response?.status === 409 && !retried) {
        SESSIONS.set(this.cacheKey, err.response.headers['x-transmission-session-id'] || '');
        return this._rpc(method, args, true);
      }
      throw this._normalizeError(err);
    }
    if (res.data?.result !== 'success') {
      throw new Error(`${this.serviceLabel} request failed: ${res.data?.result || 'unknown error'}`);
    }
    return res.data.arguments || {};
  }

  async getStatus() {
    const session = await this._rpc('session-get');
    return { version: session.version || null };
  }

  async getQueue() {
    const { torrents } = await this._rpc('torrent-get', { fields: TORRENT_FIELDS });
    return (torrents || [])
      .filter(torrent => (torrent.percentDone || 0) < 1)
      .map(torrent => {
        const size = torrent.totalSize || null;
        return {
          id: String(torrent.id),
          title: torrent.name || 'Unknown',
          subtitle: null,
          status: STATUS_LABELS[torrent.status] || 'queued',
          percent: BaseClient.clampPercent((torrent.percentDone || 0) * 100),
          timeleft: BaseClient.humanEta(torrent.eta),
          size,
          sizeleft: torrent.leftUntilDone ?? null,
          sizeHuman: BaseClient.humanSize(size),
          sizeleftHuman: BaseClient.humanSize(torrent.leftUntilDone),
          quality: null,
          protocol: 'torrent',
          downloadClient: null,
          indexer: null,
          category: null,
          speed: torrent.rateDownload > 0 ? BaseClient.humanSpeed(torrent.rateDownload) : null,
          speedBps: torrent.rateDownload > 0 ? torrent.rateDownload : null,
          seeds: typeof torrent.peersSendingToUs === 'number' ? `${torrent.peersSendingToUs}/${torrent.peersConnected ?? 0}` : null,
          warnings: torrent.errorString ? [torrent.errorString] : [],
          raw: torrent
        };
      });
  }

  // NORMALIZED FEED ROWS - NO HISTORY ENDPOINT, COMPLETED TORRENTS ARE
  // SORTED BY FINISH DATE AND SLICED CLIENT-SIDE
  async getHistory(page = 1, pageSize = 15) {
    const { torrents } = await this._rpc('torrent-get', { fields: TORRENT_FIELDS });
    const finishedAt = torrent => torrent.doneDate || torrent.addedDate || 0;
    const done = (torrents || [])
      .filter(torrent => (torrent.percentDone || 0) >= 1)
      .sort((a, b) => finishedAt(b) - finishedAt(a));
    const start = (page - 1) * pageSize;
    const slice = done.slice(start, start + pageSize);
    return {
      rows: slice.map(torrent => ({
        id: String(torrent.id),
        kind: 'completed',
        title: torrent.name || 'Unknown',
        detail: BaseClient.humanSize(torrent.totalSize),
        at: finishedAt(torrent) ? new Date(finishedAt(torrent) * 1000).toISOString() : null
      })),
      hasMore: done.length > start + slice.length
    };
  }

  // OMITTED ids TARGET EVERY TORRENT (THE RPC SPEC'S ALL-TORRENTS FORM);
  // remove KEEPS DOWNLOADED DATA ON DISK
  async queueAction(verb, id = null) {
    const args = id ? { ids: [Number(id)] } : {};
    if (verb === 'pause') return this._rpc('torrent-stop', args);
    if (verb === 'resume') return this._rpc('torrent-start', args);
    if (verb === 'remove' && id) return this._rpc('torrent-remove', { ...args, 'delete-local-data': false });
    throw new Error(`${this.serviceLabel} cannot '${verb}' a queue item`);
  }

  // torrent-add'S filename FIELD TAKES MAGNETS AND HTTP LINKS ALIKE
  async addDownload(url) {
    const result = await this._rpc('torrent-add', { filename: url });
    if (result['torrent-duplicate']) throw new Error(`${this.serviceLabel} already has that torrent`);
    return result['torrent-added'] || result;
  }

  get capabilities() {
    return {
      ...super.capabilities,
      addByUrl: true,
      queueActions: { item: ['pause', 'resume', 'remove'], queue: ['pause', 'resume'] }
    };
  }
}

module.exports = TransmissionClient;
