const UtorrentClient = require('../clients/utorrentClient');

module.exports = {
  id: 'utorrent',
  label: 'uTorrent',
  icon: '/images/utorrent.svg',
  blurb: 'BitTorrent download client',
  kind: 'download-client',
  protocol: 'torrent',
  why: 'See the downloads your requests kick off without leaving the console.',
  functions: [
    'Watch the torrent queue with speeds, seeds, and ETAs',
    'Pause, resume, or remove individual torrents',
    'Add a torrent by pasting a magnet or URL',
    'Completed torrents feed the activity rail'
  ],
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
