const EmbyClient = require('./embyClient');

// JELLYFIN FORKED EMBY AND KEPT ITS API SHAPE - ONLY THE NAME DIFFERS
class JellyfinClient extends EmbyClient {
  constructor(opts) {
    super(opts);
    this.serviceLabel = 'Jellyfin';
  }
}

module.exports = JellyfinClient;
