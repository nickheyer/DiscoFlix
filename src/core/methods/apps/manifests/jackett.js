const JackettClient = require('../clients/jackettClient');

module.exports = {
  id: 'jackett',
  label: 'Jackett',
  icon: '/images/jackett.svg',
  blurb: 'Torrent indexer proxy for the arrs',
  kind: 'indexer',
  Client: JackettClient,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:9117', description: 'Base URL of the Jackett server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'The API Key shown on the Jackett dashboard' }
  ],
  sections: ['overview', 'settings'],
  buildClient(row, logger) {
    return new JackettClient({ url: row.url, apiKey: row.api_key, logger });
  }
};
