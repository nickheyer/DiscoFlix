const PlexClient = require('../clients/plexClient');

module.exports = {
  id: 'plex',
  label: 'Plex',
  icon: '/images/plex.svg',
  blurb: 'Media server - streams your library',
  kind: 'media-server',
  why: 'Connect the place people actually watch - duplicate requests answer themselves.',
  functions: [
    'Browse and search the streaming library in-console',
    'See who is watching right now with live progress',
    'Recently added titles feed the activity rail',
    'The bot answers requests that are already streamable'
  ],
  Client: PlexClient,
  contentTypes: [],
  interactions: [require('./interactions/whatsnew')],
  browseLabel: 'title',
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:32400', description: 'Base URL of the Plex Media Server' },
    { key: 'api_key', label: 'Plex Token', type: 'string', required: true, sensitive: true, description: 'X-Plex-Token - grab it from any signed-in Plex Web session' }
  ],
  sections: ['overview', 'sessions', 'library', 'settings'],
  buildClient(row, logger) {
    return new PlexClient({ url: row.url, token: row.api_key, logger, instanceId: row.id });
  }
};
