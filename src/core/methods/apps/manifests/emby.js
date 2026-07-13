const EmbyClient = require('../clients/embyClient');

module.exports = {
  id: 'emby',
  label: 'Emby',
  icon: '/images/emby.svg',
  blurb: 'Media server for movies, TV, and music',
  kind: 'media-server',
  Client: EmbyClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:8096', description: 'Base URL of the Emby server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Dashboard → Advanced → API Keys' }
  ],
  sections: ['overview', 'settings'],
  buildClient(row, logger) {
    return new EmbyClient({ url: row.url, apiKey: row.api_key, logger });
  }
};
