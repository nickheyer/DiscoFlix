const EmbyClient = require('../clients/embyClient');

module.exports = {
  id: 'emby',
  label: 'Emby',
  icon: '/images/emby.svg',
  blurb: 'Media server for movies, TV, and music',
  kind: 'media-server',
  why: 'Connect the place people actually watch - duplicate requests answer themselves.',
  functions: [
    'Browse and search the streaming library in-console',
    'See who is watching right now with live progress',
    'Recently added titles feed the activity rail',
    'The bot answers requests that are already streamable'
  ],
  Client: EmbyClient,
  contentTypes: [],
  browseLabel: 'title',
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:8096', description: 'Base URL of the Emby server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Dashboard → Advanced → API Keys' }
  ],
  sections: ['overview', 'sessions', 'library', 'settings'],
  buildClient(row, logger) {
    return new EmbyClient({ url: row.url, apiKey: row.api_key, logger, instanceId: row.id });
  }
};
