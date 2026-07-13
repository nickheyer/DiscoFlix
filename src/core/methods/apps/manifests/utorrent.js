const UtorrentClient = require('../clients/utorrentClient');

module.exports = {
  id: 'utorrent',
  label: 'uTorrent',
  icon: '/images/utorrent.svg',
  blurb: 'BitTorrent download client',
  kind: 'download-client',
  Client: UtorrentClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'WebUI URL', type: 'string', required: true, placeholder: 'http://localhost:8080', description: 'Base URL of the uTorrent WebUI' },
    { key: 'username', label: 'Username', type: 'string', required: true, description: 'WebUI login username' },
    { key: 'password', label: 'Password', type: 'string', required: true, sensitive: true, description: 'WebUI login password' }
  ],
  sections: ['overview', 'queue', 'settings'],
  buildClient(row, logger) {
    return new UtorrentClient({ url: row.url, username: row.username, password: row.password, logger, cacheKey: row.id });
  }
};
