const NzbgetClient = require('../clients/nzbgetClient');

module.exports = {
  id: 'nzbget',
  label: 'NZBGet',
  icon: '/images/nzbget.svg',
  blurb: 'Usenet download client',
  kind: 'download-client',
  protocol: 'usenet',
  why: 'See the downloads your requests kick off without leaving the console.',
  functions: [
    'Watch the usenet queue with live speeds and ETAs',
    'Pause, resume, or remove groups per item or globally',
    'Queue an NZB by pasting its link',
    'Download history feeds the activity rail'
  ],
  Client: NzbgetClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:6789', description: 'Base URL of the NZBGet server' },
    { key: 'username', label: 'Username', type: 'string', required: false, placeholder: 'nzbget', description: 'ControlUsername - leave blank when authentication is off' },
    { key: 'password', label: 'Password', type: 'string', required: false, sensitive: true, description: 'ControlPassword - leave blank when authentication is off' }
  ],
  sections: ['overview', 'queue', 'settings'],
  buildClient(row, logger) {
    return new NzbgetClient({ url: row.url, username: row.username, password: row.password, logger });
  }
};
