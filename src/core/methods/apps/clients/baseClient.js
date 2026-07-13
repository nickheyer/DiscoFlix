// MINIMAL COMMON CONTRACT FOR EVERY APP CLIENT (ARR, SABNZBD, QBITTORRENT...).
// EVERY CLIENT MUST RESOLVE getStatus() -> { version } AND getQueue() -> AN
// ARRAY OF NORMALIZED QUEUE ROWS:
//   { id, title, subtitle?, status, percent (0-100 int), timeleft, size,
//     sizeleft, sizeHuman?, sizeleftHuman?, quality?, protocol?, category?,
//     downloadClient?, indexer?, speed?, seeds?, warnings [], raw }
// THE NORMALIZED SHAPE IS SHARED BY THE MONITOR, THE DOWNLOAD TICKER, AND
// EVERY QUEUE UI - ONLY matchesQueueRecord IMPLEMENTATIONS MAY REACH INTO raw.
// getHistory(page) -> { rows, hasMore } OF NORMALIZED FEED ROWS:
//   { id, kind ('grabbed'|'imported'|'completed'|'failed'|'deleted'|'renamed'|
//     'ignored'|'info'), title, detail, at (ISO STRING) }
// - THE ACTIVITY FEED IN THE TAKEOVER'S RIGHT RAIL RENDERS THESE.
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

  // BYTES/SEC -> HUMAN RATE FOR QUEUE ROWS
  static humanSpeed(bytesPerSecond) {
    const size = BaseClient.humanSize(bytesPerSecond);
    return size ? `${size}/s` : null;
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

  // UI/DISPATCH HINTS - queueActions.item/queue LIST THE VERBS EACH QUEUE SURFACE OFFERS
  get capabilities() {
    return { search: false, add: false, library: false, libraryDetail: false, health: false, queueActions: { item: [], queue: [] } };
  }
}

module.exports = BaseClient;
