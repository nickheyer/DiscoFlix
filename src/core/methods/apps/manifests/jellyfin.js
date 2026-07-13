const JellyfinClient = require('../clients/jellyfinClient');

module.exports = {
  id: 'jellyfin',
  label: 'Jellyfin',
  icon: '/images/jellyfin.svg',
  blurb: 'Free software media server',
  kind: 'media-server',
  Client: JellyfinClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:8096', description: 'Base URL of the Jellyfin server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Dashboard → API Keys' }
  ],
  sections: ['overview', 'settings'],
  buildClient(row, logger) {
    return new JellyfinClient({ url: row.url, apiKey: row.api_key, logger });
  }
};
