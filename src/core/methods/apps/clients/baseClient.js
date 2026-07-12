// MINIMAL COMMON CONTRACT FOR EVERY APP CLIENT (ARR, SABNZBD, QBITTORRENT...).
// EVERY CLIENT MUST RESOLVE getStatus() -> { version } AND getQueue() -> AN
// ARRAY OF NORMALIZED QUEUE ROWS:
//   { id, title, status, percent (0-100 int), timeleft, size, sizeleft, raw }
// THE NORMALIZED SHAPE IS SHARED BY THE MONITOR, THE DOWNLOAD TICKER, AND
// EVERY QUEUE UI — ONLY matchesQueueRecord IMPLEMENTATIONS MAY REACH INTO raw.
// getHistory(page) -> { rows, hasMore } OF NORMALIZED FEED ROWS:
//   { id, kind ('grabbed'|'imported'|'completed'|'failed'|'deleted'|'renamed'|
//     'ignored'|'info'), title, detail, at (ISO STRING) }
// — THE ACTIVITY FEED IN THE TAKEOVER'S RIGHT RAIL RENDERS THESE.
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

  // ERRORS ARE REWRAPPED WITH A USER-PRESENTABLE MESSAGE — THE REQUEST FLOW
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

  // UI/DISPATCH HINTS — CONTENT MANAGERS OVERRIDE search/add/health
  get capabilities() {
    return { search: false, add: false, library: false, health: false, pauseResume: false };
  }
}

module.exports = BaseClient;
