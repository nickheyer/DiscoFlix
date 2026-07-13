const SonarrClient = require('../clients/sonarrClient');

module.exports = {
  id: 'sonarr',
  label: 'Sonarr',
  icon: '/images/sonarr.min.svg',
  blurb: 'TV shows - search, request, and track',
  kind: 'content-manager',
  why: 'The engine behind show requests - the bot cannot add series without it.',
  functions: [
    'Search and request TV shows straight from Discord',
    'Approve, deny, and track requests in the console',
    'Browse the series library with season progress',
    'Follow grabs through import with live progress'
  ],
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
  sections: ['overview', 'queue', 'library', 'settings'],
  buildClient(row, logger) {
    return new SonarrClient({ url: row.url, token: row.api_key, logger });
  }
};
