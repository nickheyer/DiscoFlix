const RutorrentClient = require('../clients/rutorrentClient');

module.exports = {
  id: 'rutorrent',
  label: 'ruTorrent',
  icon: '/images/rutorrent.svg',
  blurb: 'rTorrent web front end',
  kind: 'download-client',
  protocol: 'torrent',
  why: 'See the downloads your requests kick off without leaving the console.',
  functions: [
    'Watch the torrent queue with speeds and ETAs',
    'Pause, resume, or erase individual torrents',
    'Add a torrent by pasting a magnet or URL',
    'Finished torrents feed the activity rail'
  ],
  Client: RutorrentClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost/rutorrent', description: 'Base URL of the ruTorrent web UI (httprpc plugin required)' },
    { key: 'username', label: 'Username', type: 'string', required: false, description: 'HTTP basic auth username, if the UI sits behind one' },
    { key: 'password', label: 'Password', type: 'string', required: false, sensitive: true, description: 'HTTP basic auth password, if the UI sits behind one' }
  ],
  sections: ['overview', 'queue', 'settings'],
  buildClient(row, logger) {
    return new RutorrentClient({ url: row.url, username: row.username, password: row.password, logger });
  }
};
