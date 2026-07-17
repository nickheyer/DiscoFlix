const TransmissionClient = require('../clients/transmissionClient');

module.exports = {
  id: 'transmission',
  label: 'Transmission',
  icon: '/images/transmission.svg',
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
  Client: TransmissionClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:9091', description: 'Base URL of the Transmission server' },
    { key: 'username', label: 'Username', type: 'string', required: false, description: 'Only when RPC authentication is on' },
    { key: 'password', label: 'Password', type: 'string', required: false, sensitive: true, description: 'Only when RPC authentication is on' }
  ],
  sections: ['overview', 'queue', 'settings'],
  buildClient(row, logger) {
    return new TransmissionClient({ url: row.url, username: row.username, password: row.password, logger, cacheKey: row.id });
  }
};
