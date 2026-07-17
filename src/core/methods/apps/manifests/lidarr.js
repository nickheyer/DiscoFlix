const LidarrClient = require('../clients/lidarrClient');

module.exports = {
  id: 'lidarr',
  label: 'Lidarr',
  icon: '/images/lidarr.svg',
  blurb: 'Music - search, request, and track albums',
  kind: 'content-manager',
  why: 'The engine behind music requests - the bot cannot add albums without it.',
  functions: [
    'Search and request albums straight from Discord',
    'Approve, deny, and track requests in the console',
    'Browse the album library and add releases yourself',
    'Follow grabs through import with live progress'
  ],
  Client: LidarrClient,
  contentTypes: [{
    type: 'music',
    label: 'album',
    slash: { name: 'music', description: 'Search for and request an album' },
    aliases: ['music', 'album', 'albums', 'artist'],
    externalIdField: 'musicbrainz_id'
  }],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:8686', description: 'Base URL of the Lidarr server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Settings → General → API Key' }
  ],
  // LIVE-FETCHED DEFAULTS STORED IN settings_json - BLANK = SERVICE'S FIRST
  instanceOptions: [
    { key: 'root_folder', label: 'Root Folder', description: 'Where new artists are stored', fetch: 'rootFolders' },
    { key: 'quality_profile', label: 'Quality Profile', description: 'Profile applied to new adds', fetch: 'qualityProfiles' },
    { key: 'metadata_profile', label: 'Metadata Profile', description: 'Which releases of an artist Lidarr tracks', fetch: 'metadataProfiles' }
  ],
  sections: ['overview', 'queue', 'library', 'settings'],
  buildClient(row, logger) {
    let settings = {};
    try { settings = JSON.parse(row.settings_json || '{}'); } catch (err) { settings = {}; }
    return new LidarrClient({ url: row.url, token: row.api_key, logger, settings });
  }
};
