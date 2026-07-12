const SabnzbdClient = require('../clients/sabnzbdClient');

module.exports = {
  id: 'sabnzbd',
  label: 'SABnzbd',
  icon: '/images/sabnzbd.min.svg',
  blurb: 'Usenet download client',
  kind: 'download-client',
  Client: SabnzbdClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:8080', description: 'Base URL of the SABnzbd server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Config → General → API Key' }
  ],
  sections: ['overview', 'queue', 'settings'],
  buildClient(row, logger) {
    return new SabnzbdClient({ url: row.url, apiKey: row.api_key, logger });
  }
};
