// MINIMAL COMMON CONTRACT FOR EVERY APP CLIENT (ARR, SABNZBD, QBITTORRENT...).
// EVERY CLIENT MUST RESOLVE getStatus() -> { version } AND getQueue() -> AN
// ARRAY OF NORMALIZED QUEUE ROWS:
//   { id, title, subtitle?, status, percent (0-100 int), timeleft, size,
//     sizeleft, sizeHuman?, sizeleftHuman?, quality?, protocol?, category?,
//     downloadClient?, indexer?, speed?, speedBps?, seeds?, warnings [], raw }
// speed IS THE HUMANIZED STRING; speedBps IS THE NUMERIC RATE (BYTES/SEC,
// null WHEN IDLE) THAT aggregateQueueSpeed FOLDS INTO OVERVIEW STATS.
// THE NORMALIZED SHAPE IS SHARED BY THE MONITOR, THE DOWNLOAD TICKER, AND
// EVERY QUEUE UI - ONLY matchesQueueRecord IMPLEMENTATIONS MAY REACH INTO raw.
// getHistory(page) -> { rows, hasMore } OF NORMALIZED FEED ROWS:
//   { id, kind ('grabbed'|'imported'|'completed'|'failed'|'deleted'|'renamed'|
//     'ignored'|'info'), title, detail, at (ISO STRING), media?, art? }
// - THE ACTIVITY FEED IN THE TAKEOVER'S RIGHT RAIL RENDERS THESE.
// media IS THE OPTIONAL IDENTITY DESCRIPTOR CROSS-INSTANCE MERGES KEY ON:
//   { kind ('movie'|'show'|'music'), title (SHOW/MOVIE/ALBUM NAME), year,
//     season?, episode?, episodeCount?, externalIds? }
// art IS AN OPTIONAL SERVICE-RELATIVE POSTER PATH fetchImage CAN PROXY -
// /whatsnew FETCHES IT THROUGH THE OWNING CLIENT AND ATTACHES THE BYTES,
// SO LAN URLS AND TOKENS NEVER REACH DISCORD.
// OPT-IN SURFACES (GATED BY capabilities, SEE THE GETTER):
// getSessions() -> NORMALIZED STREAM ROWS FOR THE NOW PLAYING SECTION:
//   { id, title, subtitle?, user, device, state ('playing'|'paused'|
//     'buffering'), percent, chips [], raw }
// searchReleases(term) -> NORMALIZED RELEASE ROWS FOR THE RELEASES SECTION:
//   { id, title, indexer?, category?, protocol ('torrent'|'usenet'), size,
//     sizeHuman?, seeders?, age?, downloadUrl, raw }
// addDownload(url) -> HANDS A MAGNET/TORRENT/NZB LINK TO A DOWNLOAD CLIENT
// getIndexers() -> [{ id, name, kind?, error? }] | null WHEN UNSUPPORTED
// fetchImage(path) -> { buffer, contentType } PROXIED ART (TOKENS STAY
//   SERVER-SIDE - SERVICE URLS/SECRETS NEVER RENDER INTO <img> TAGS)
class BaseClient {
  constructor({ url, logger }) {
    this.serviceLabel = 'App';
    this.logger = logger;
    this.baseUrl = BaseClient.normalizeUrl(url);
  }

  static normalizeUrl(url) {
    let normalized = String(url || '').trim().replace(/\/+$/, '');
    if (normalized && !/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }
    return normalized;
  }

  static clampPercent(value) {
    const num = Number(value);
    if (isNaN(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  static humanSize(bytes) {
    const num = Number(bytes);
    if (isNaN(num) || num <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = num;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  // ERRORS ARE REWRAPPED WITH A USER-PRESENTABLE MESSAGE - THE REQUEST FLOW
  // ECHOES `err.message` STRAIGHT INTO DISCORD
  _normalizeError(err) {
    let message;
    if (err.response) {
      message = [401, 403].includes(err.response.status)
        ? `${this.serviceLabel} rejected the configured credentials`
        : `${this.serviceLabel} responded with HTTP ${err.response.status}`;
    } else if (err.request) {
      message = `${this.serviceLabel} is unreachable at ${this.baseUrl}`;
    } else {
      message = `${this.serviceLabel} request failed: ${err.message}`;
    }
    const wrapped = new Error(message);
    wrapped.cause = err;
    return wrapped;
  }

  // CONTRACT
  async getStatus() { throw new Error('NOT_IMPLEMENTED'); }
  async getQueue() { throw new Error('NOT_IMPLEMENTED'); }
  async getHealth() { return []; }
  async getHistory() { return { rows: [], hasMore: false }; }
  async queueAction() { throw new Error('NOT_IMPLEMENTED'); } // (verb, id) - NULL id TARGETS THE WHOLE QUEUE
  async addDownload() { throw new Error('NOT_IMPLEMENTED'); } // (url) - MAGNET/TORRENT/NZB LINK
  async getSessions() { throw new Error('NOT_IMPLEMENTED'); }
  async searchReleases() { throw new Error('NOT_IMPLEMENTED'); }
  async getIndexers() { return null; }
  async fetchImage() { throw new Error('NOT_IMPLEMENTED'); }

  // BYTES/SEC -> HUMAN RATE FOR QUEUE ROWS
  static humanSpeed(bytesPerSecond) {
    const size = BaseClient.humanSize(bytesPerSecond);
    return size ? `${size}/s` : null;
  }

  // TOTAL DOWNLOAD RATE ACROSS NORMALIZED QUEUE ROWS. PER-ITEM CLIENTS SUM;
  // CLIENTS THAT PIN ONE GLOBAL RATE ON EVERY ROW (SABNZBD, NZBGET) OVERRIDE
  // WITH max() SO THE FIGURE ISN'T MULTIPLIED BY QUEUE LENGTH.
  aggregateQueueSpeed(rows) {
    return (rows || []).reduce((sum, row) => sum + (Number(row.speedBps) || 0), 0);
  }

  // SECONDS -> COMPACT ETA ("2d 4h", "3h 12m", "9m") FOR QUEUE ROWS
  static humanEta(seconds) {
    const num = Number(seconds);
    if (isNaN(num) || num <= 0 || !isFinite(num)) return null;
    const hours = Math.floor(num / 3600);
    const minutes = Math.floor((num % 3600) / 60);
    if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
  }

  // ZERO-PADDED SEASON/EPISODE CODE ("S02E05") - null WITHOUT A SEASON NUMBER
  static seasonEpisodeCode(season, episode) {
    if (season == null || isNaN(Number(season))) return null;
    const code = `S${String(season).padStart(2, '0')}`;
    if (episode == null || isNaN(Number(episode))) return code;
    return `${code}E${String(episode).padStart(2, '0')}`;
  }

  static formatDate(value) {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  static formatRuntime(minutes) {
    const num = Number(minutes);
    if (isNaN(num) || num <= 0) return null;
    return num >= 60 ? `${Math.floor(num / 60)}h ${num % 60}m` : `${num}m`;
  }

  // PUBLISH DATE -> COMPACT AGE ("3h", "5d", "2y") FOR RELEASE ROWS
  static humanAge(value) {
    if (!value) return null;
    const then = new Date(value).getTime();
    if (isNaN(then)) return null;
    const days = Math.max(0, (Date.now() - then) / 86400000);
    if (days < 1) return `${Math.max(1, Math.floor(days * 24))}h`;
    if (days < 365) return `${Math.floor(days)}d`;
    return `${(days / 365).toFixed(1)}y`;
  }

  // UI/DISPATCH HINTS - queueActions.item/queue LIST THE VERBS EACH QUEUE
  // SURFACE OFFERS. SUBCLASSES SPREAD super.capabilities SO NEW FLAGS GET A
  // SAFE DEFAULT EVERYWHERE AT ONCE.
  get capabilities() {
    return {
      search: false,
      add: false,
      library: false,
      libraryDetail: false,
      health: false,
      sessions: false,
      releases: false,
      addByUrl: false,
      queueActions: { item: [], queue: [] }
    };
  }
}

module.exports = BaseClient;
