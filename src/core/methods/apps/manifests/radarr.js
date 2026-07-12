const RadarrClient = require('../clients/radarrClient');

module.exports = {
  id: 'radarr',
  label: 'Radarr',
  icon: '/images/radarr.min.svg',
  blurb: 'Movies — search, request, and track',
  kind: 'content-manager',
  Client: RadarrClient,
  contentTypes: [{
    type: 'movie',
    label: 'movie',
    slash: { name: 'movie', description: 'Search for and request a movie' },
    aliases: ['movie', 'movies', 'film'],
    externalIdField: 'tmdb_id'
  }],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:7878', description: 'Base URL of the Radarr server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Settings → General → API Key' }
  ],
  sections: ['overview', 'queue', 'library', 'history', 'search', 'settings'],
  buildClient(row, logger) {
    return new RadarrClient({ url: row.url, token: row.api_key, logger });
  }
};
