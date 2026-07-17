const DelugeClient = require('../clients/delugeClient');

module.exports = {
  id: 'deluge',
  label: 'Deluge',
  icon: '/images/deluge.svg',
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
  Client: DelugeClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'WebUI URL', type: 'string', required: true, placeholder: 'http://localhost:8112', description: 'Base URL of the Deluge web UI' },
    { key: 'password', label: 'Password', type: 'string', required: true, sensitive: true, description: 'The web UI password - Deluge has no username' }
  ],
  sections: ['overview', 'queue', 'settings'],
  buildClient(row, logger) {
    return new DelugeClient({ url: row.url, password: row.password, logger, cacheKey: row.id });
  }
};
