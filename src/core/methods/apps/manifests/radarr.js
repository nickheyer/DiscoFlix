const RadarrClient = require('../clients/radarrClient');

module.exports = {
  id: 'radarr',
  label: 'Radarr',
  icon: '/images/radarr.min.svg',
  blurb: 'Movies - search, request, and track',
  kind: 'content-manager',
  why: 'The engine behind movie requests - the bot cannot add movies without it.',
  functions: [
    'Search and request movies straight from Discord',
    'Approve, deny, and track requests in the console',
    'Browse the movie library and add titles yourself',
    'Follow grabs through import with live progress'
  ],
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
  // LIVE-FETCHED DEFAULTS STORED IN settings_json - BLANK = SERVICE'S FIRST
  instanceOptions: [
    { key: 'root_folder', label: 'Root Folder', description: 'Where new movies are stored', fetch: 'rootFolders' },
    { key: 'quality_profile', label: 'Quality Profile', description: 'Profile applied to new adds', fetch: 'qualityProfiles' }
  ],
  sections: ['overview', 'queue', 'library', 'settings'],
  buildClient(row, logger) {
    let settings = {};
    try { settings = JSON.parse(row.settings_json || '{}'); } catch (err) { settings = {}; }
    return new RadarrClient({ url: row.url, token: row.api_key, logger, settings });
  }
};
