const QbittorrentClient = require('../clients/qbittorrentClient');

module.exports = {
  id: 'qbittorrent',
  label: 'qBittorrent',
  icon: '/images/qbittorrent.min.svg',
  blurb: 'BitTorrent download client',
  kind: 'download-client',
  protocol: 'torrent',
  why: 'See the downloads your requests kick off without leaving the console.',
  functions: [
    'Watch the torrent queue with speeds, seeds, and ETAs',
    'Pause, resume, or remove torrents per item or globally',
    'Add a torrent by pasting a magnet or URL',
    'Completed torrents feed the activity rail'
  ],
  Client: QbittorrentClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'WebUI URL', type: 'string', required: true, placeholder: 'http://localhost:8080', description: 'Base URL of the qBittorrent WebUI' },
    { key: 'username', label: 'Username', type: 'string', required: true, description: 'WebUI login username' },
    { key: 'password', label: 'Password', type: 'string', required: true, sensitive: true, description: 'WebUI login password' }
  ],
  sections: ['overview', 'queue', 'settings'],
  buildClient(row, logger) {
    return new QbittorrentClient({
      url: row.url,
      username: row.username,
      password: row.password,
      logger,
      cacheKey: row.id
    });
  }
};
