const JellyfinClient = require('../clients/jellyfinClient');

module.exports = {
  id: 'jellyfin',
  label: 'Jellyfin',
  icon: '/images/jellyfin.svg',
  blurb: 'Free software media server',
  kind: 'media-server',
  why: 'Connect the place people actually watch - duplicate requests answer themselves.',
  functions: [
    'Browse and search the streaming library in-console',
    'See who is watching right now with live progress',
    'Recently added titles feed the activity rail',
    'The bot answers requests that are already streamable'
  ],
  Client: JellyfinClient,
  contentTypes: [],
  interactions: [require('./interactions/whatsnew')],
  browseLabel: 'title',
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:8096', description: 'Base URL of the Jellyfin server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Dashboard → API Keys' }
  ],
  sections: ['overview', 'sessions', 'library', 'settings'],
  buildClient(row, logger) {
    return new JellyfinClient({ url: row.url, apiKey: row.api_key, logger, instanceId: row.id });
  }
};
