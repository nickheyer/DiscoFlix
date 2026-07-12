const SonarrClient = require('../clients/sonarrClient');

module.exports = {
  id: 'sonarr',
  label: 'Sonarr',
  icon: '/images/sonarr.min.svg',
  blurb: 'TV shows — search, request, and track',
  kind: 'content-manager',
  Client: SonarrClient,
  contentTypes: [{
    type: 'show',
    label: 'show',
    slash: { name: 'show', description: 'Search for and request a TV show' },
    aliases: ['show', 'shows', 'tv', 'series', 'tv-show', 'anime'],
    externalIdField: 'tvdb_id'
  }],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:8989', description: 'Base URL of the Sonarr server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Settings → General → API Key' }
  ],
  sections: ['overview', 'queue', 'library', 'search', 'settings'],
  buildClient(row, logger) {
    return new SonarrClient({ url: row.url, token: row.api_key, logger });
  }
};
