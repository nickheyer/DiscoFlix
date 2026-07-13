const PlexClient = require('../clients/plexClient');

module.exports = {
  id: 'plex',
  label: 'Plex',
  icon: '/images/plex.svg',
  blurb: 'Media server - streams your library',
  kind: 'media-server',
  Client: PlexClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:32400', description: 'Base URL of the Plex Media Server' },
    { key: 'api_key', label: 'Plex Token', type: 'string', required: true, sensitive: true, description: 'X-Plex-Token - grab it from any signed-in Plex Web session' }
  ],
  sections: ['overview', 'settings'],
  buildClient(row, logger) {
    return new PlexClient({ url: row.url, token: row.api_key, logger });
  }
};
