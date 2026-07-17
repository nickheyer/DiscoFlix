const axios = require('axios');
const BaseClient = require('./baseClient');

const MB = 1024 * 1024;

// GROUP STATUSES THAT SHOULD SHOW THE RESUME BUTTON
const PAUSED_STATUSES = new Set(['PAUSED', 'PP_PAUSED']);

// NZBGET JSON-RPC AT /jsonrpc - CONTROL USERNAME/PASSWORD RIDE HTTP BASIC
// AUTH AND ARE OPTIONAL (NZBGET CAN RUN WITH AUTHENTICATION OFF)
class NzbgetClient extends BaseClient {
  constructor({ url, username, password, logger }) {
    super({ url, logger });
    this.serviceLabel = 'NZBGet';
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      auth: username || password ? { username: username || '', password: password || '' } : undefined
    });
  }

  async _call(method, params = []) {
    let data;
    try {
      ({ data } = await this.http.post('/jsonrpc', { method, params, id: 1 }));
    } catch (err) {
      throw this._normalizeError(err);
    }
    if (data && data.error) {
      throw new Error(`${this.serviceLabel} request failed: ${data.error.message || data.error.code}`);
    }
    return data ? data.result : null;
  }

  async getStatus() {
    const version = await this._call('version');
    return { version: version ? String(version) : null };
  }

  // NZBGET REPORTS ONE GLOBAL RATE - PIN IT ON WHATEVER IS ACTUALLY DOWNLOADING
  async getQueue() {
    const [groups, status] = await Promise.all([
      this._call('listgroups', [0]),
      this._call('status')
    ]);
    const rate = Number(status?.DownloadRate) || 0;
    return (groups || []).map(group => {
      const size = (Number(group.FileSizeMB) || 0) * MB;
      const sizeleft = (Number(group.RemainingSizeMB) || 0) * MB;
      const groupStatus = String(group.Status || 'QUEUED');
      const downloading = groupStatus === 'DOWNLOADING';
      const paused = PAUSED_STATUSES.has(groupStatus);
      const secondsLeft = downloading && rate > 0 ? sizeleft / rate : null;
      return {
        id: String(group.NZBID),
        title: group.NZBName || 'Unknown',
        subtitle: null,
        status: paused ? 'paused' : groupStatus.toLowerCase().replace(/_/g, ' '),
        percent: size ? BaseClient.clampPercent(((size - sizeleft) / size) * 100) : 0,
        timeleft: secondsLeft ? BaseClient.humanEta(secondsLeft) : null,
        size: size || null,
        sizeleft: size ? sizeleft : null,
        sizeHuman: BaseClient.humanSize(size),
        sizeleftHuman: BaseClient.humanSize(sizeleft),
        quality: null,
        protocol: 'usenet',
        downloadClient: null,
        indexer: null,
        category: group.Category || null,
        speed: downloading && rate > 0 ? BaseClient.humanSpeed(rate) : null,
        speedBps: downloading && rate > 0 ? rate : null,
        seeds: null,
        warnings: [],
        raw: group
      };
    });
  }

  // THE GLOBAL RATE RIDES EVERY DOWNLOADING ROW - max() READS IT BACK ONCE
  aggregateQueueSpeed(rows) {
    return Math.max(0, ...(rows || []).map(row => Number(row.speedBps) || 0));
  }

  // NORMALIZED FEED ROWS (SEE baseClient CONTRACT) - NZBGET RETURNS THE WHOLE
  // HISTORY IN ONE CALL, SO PAGES ARE SLICED CLIENT-SIDE
  async getHistory(page = 1, pageSize = 15) {
    const items = await this._call('history', [false]);
    const start = (page - 1) * pageSize;
    const slice = (items || []).slice(start, start + pageSize);
    return {
      rows: slice.map(item => {
        const status = String(item.Status || '');
        const kind = /DELETED/i.test(status) ? 'deleted' : (/FAILURE|DAMAGED|BAD/i.test(status) ? 'failed' : 'completed');
        const detail = [
          item.Category || null,
          BaseClient.humanSize((Number(item.FileSizeMB) || 0) * MB)
        ].filter(Boolean).join(' • ');
        return {
          id: String(item.NZBID || item.ID),
          kind,
          title: item.Name || item.NZBName || 'Unknown',
          detail: detail || null,
          at: item.HistoryTime ? new Date(item.HistoryTime * 1000).toISOString() : null
        };
      }),
      hasMore: (items || []).length > start + slice.length
    };
  }

  // NULL id FLIPS THE GLOBAL DOWNLOAD SWITCH; PER-GROUP VERBS RIDE editqueue
  async queueAction(verb, id = null) {
    if (!id) {
      if (verb === 'pause') return this._call('pausedownload');
      if (verb === 'resume') return this._call('resumedownload');
      throw new Error(`${this.serviceLabel} cannot '${verb}' the queue`);
    }
    const commands = { pause: 'GroupPause', resume: 'GroupResume', remove: 'GroupDelete' };
    if (!commands[verb]) throw new Error(`${this.serviceLabel} cannot '${verb}' a queue item`);
    const ok = await this._call('editqueue', [commands[verb], '', [Number(id)]]);
    if (!ok) throw new Error(`${this.serviceLabel} refused to ${verb} that item`);
    return ok;
  }

  // append'S Content PARAMETER TAKES A URL AS WELL AS BASE64 NZB DATA (v14+)
  async addDownload(url) {
    const id = await this._call('append', ['', url, '', 0, false, false, '', 0, 'SCORE']);
    if (!id || id <= 0) throw new Error(`${this.serviceLabel} did not accept that link`);
    return id;
  }

  get capabilities() {
    return {
      ...super.capabilities,
      addByUrl: true,
      queueActions: { item: ['pause', 'resume', 'remove'], queue: ['pause', 'resume'] }
    };
  }
}

module.exports = NzbgetClient;
