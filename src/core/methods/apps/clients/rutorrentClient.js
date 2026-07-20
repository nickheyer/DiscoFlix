const axios = require('axios');
const BaseClient = require('./baseClient');
const tuning = require('../../../tuning');

// HTTPRPC mode=list COLUMN ORDER - RUTORRENT'S OWN WEBUI CONTRACT
const COL = {
  IS_OPEN: 0,
  NAME: 4,
  SIZE: 5,
  DONE: 8,
  DOWN_RATE: 12,
  LABEL: 14,
  LEFT: 19,
  STATE_CHANGED: 21,
  HASHING: 23,
  IS_ACTIVE: 28,
  MESSAGE: 29
};

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// RUTORRENT'S HTTPRPC PLUGIN - mode=list FOR THE TORRENT TABLE, RAW XML-RPC
// PASSTHROUGH TO RTORRENT FOR EVERYTHING ELSE (VERSION, PAUSE, ERASE...)
class RutorrentClient extends BaseClient {
  constructor({ url, username, password, logger }) {
    super({ url, logger });
    this.serviceLabel = 'ruTorrent';
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: tuning.value('download_client_http_timeout_seconds') * 1000,
      auth: username || password ? { username: username || '', password: password || '' } : undefined
    });
  }

  async _list() {
    let data;
    try {
      ({ data } = await this.http.post('/plugins/httprpc/action.php',
        new URLSearchParams({ mode: 'list' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      ));
    } catch (err) {
      throw this._normalizeError(err);
    }
    if (!data || typeof data !== 'object' || !('t' in data)) {
      throw new Error(`${this.serviceLabel} answered without a torrent list - is the httprpc plugin enabled?`);
    }
    return data.t || {};
  }

  async _xmlrpc(method, params = []) {
    const body = `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>${
      params.map(param => `<param><value><string>${xmlEscape(param)}</string></value></param>`).join('')
    }</params></methodCall>`;
    let data;
    try {
      ({ data } = await this.http.post('/plugins/httprpc/action.php', body, {
        headers: { 'Content-Type': 'text/xml' }
      }));
    } catch (err) {
      throw this._normalizeError(err);
    }
    const text = String(data);
    const fault = text.match(/<name>faultString<\/name>\s*<value>(?:<string>)?([^<]*)/);
    if (fault) throw new Error(`${this.serviceLabel} request failed: ${fault[1]}`);
    const value = text.match(/<value>(?:<(?:string|i4|i8|int)>)?([^<]*)/);
    return value ? value[1] : null;
  }

  async getStatus() {
    const version = await this._xmlrpc('system.client_version');
    return { version: version || null };
  }

  async getQueue() {
    const torrents = await this._list();
    return Object.entries(torrents)
      .filter(([, cols]) => Number(cols[COL.LEFT]) > 0)
      .map(([hash, cols]) => {
        const size = Number(cols[COL.SIZE]) || 0;
        const left = Number(cols[COL.LEFT]) || 0;
        const done = Number(cols[COL.DONE]) || 0;
        const active = Number(cols[COL.IS_ACTIVE]) === 1 && Number(cols[COL.IS_OPEN]) === 1;
        const hashing = Number(cols[COL.HASHING]) > 0;
        const rate = Number(cols[COL.DOWN_RATE]) || 0;
        const message = String(cols[COL.MESSAGE] || '');
        let status = 'paused';
        if (hashing) status = 'checking';
        else if (active) status = rate > 0 ? 'downloading' : 'stalled';
        return {
          id: hash,
          title: String(cols[COL.NAME] || 'Unknown'),
          subtitle: null,
          status,
          percent: size ? BaseClient.clampPercent((done / size) * 100) : 0,
          timeleft: rate > 0 ? BaseClient.humanEta(left / rate) : null,
          size: size || null,
          sizeleft: size ? left : null,
          sizeHuman: BaseClient.humanSize(size),
          sizeleftHuman: BaseClient.humanSize(left),
          quality: null,
          protocol: 'torrent',
          downloadClient: null,
          indexer: null,
          category: String(cols[COL.LABEL] || '') || null,
          speed: rate > 0 ? BaseClient.humanSpeed(rate) : null,
          speedBps: rate > 0 ? rate : null,
          seeds: null,
          warnings: message ? [message] : [],
          raw: { hash, cols }
        };
      });
  }

  // NORMALIZED FEED ROWS - RTORRENT KEEPS NO HISTORY, SO FINISHED TORRENTS
  // STAND IN, ORDERED BY THEIR LAST STATE CHANGE
  async getHistory(page = 1, pageSize = 15) {
    const torrents = await this._list();
    const done = Object.entries(torrents)
      .filter(([, cols]) => Number(cols[COL.LEFT]) === 0)
      .sort((a, b) => (Number(b[1][COL.STATE_CHANGED]) || 0) - (Number(a[1][COL.STATE_CHANGED]) || 0));
    const start = (page - 1) * pageSize;
    const slice = done.slice(start, start + pageSize);
    return {
      rows: slice.map(([hash, cols]) => {
        const stateChanged = Number(cols[COL.STATE_CHANGED]) || 0;
        const detail = [
          String(cols[COL.LABEL] || '') || null,
          BaseClient.humanSize(Number(cols[COL.SIZE]))
        ].filter(Boolean).join(' • ');
        return {
          id: hash,
          kind: 'completed',
          title: String(cols[COL.NAME] || 'Unknown'),
          detail: detail || null,
          at: stateChanged ? new Date(stateChanged * 1000).toISOString() : null
        };
      }),
      hasMore: done.length > start + slice.length
    };
  }

  // PER-TORRENT ONLY - RTORRENT HAS NO SESSION-WIDE PAUSE WORTH TRUSTING
  async queueAction(verb, id = null) {
    if (!id) throw new Error(`${this.serviceLabel} cannot '${verb}' the whole queue`);
    if (verb === 'pause') return this._xmlrpc('d.pause', [id]);
    if (verb === 'resume') return this._xmlrpc('d.resume', [id]);
    if (verb === 'remove') return this._xmlrpc('d.erase', [id]);
    throw new Error(`${this.serviceLabel} cannot '${verb}' a queue item`);
  }

  // RTORRENT ITSELF FETCHES THE LINK - load.start HANDLES MAGNET AND HTTP
  async addDownload(url) {
    return this._xmlrpc('load.start', ['', url]);
  }

  get capabilities() {
    return {
      ...super.capabilities,
      addByUrl: true,
      queueActions: { item: ['pause', 'resume', 'remove'], queue: [] }
    };
  }
}

module.exports = RutorrentClient;
