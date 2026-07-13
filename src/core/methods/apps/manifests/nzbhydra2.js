const Nzbhydra2Client = require('../clients/nzbhydra2Client');

module.exports = {
  id: 'nzbhydra2',
  label: 'NZBHydra2',
  icon: '/images/nzbhydra2.svg',
  blurb: 'Meta search for usenet indexers',
  kind: 'indexer',
  Client: Nzbhydra2Client,
  contentTypes: [],
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:5076', description: 'Base URL of the NZBHydra2 server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Config → Main → API key' }
  ],
  sections: ['overview', 'settings'],
  buildClient(row, logger) {
    return new Nzbhydra2Client({ url: row.url, apiKey: row.api_key, logger });
  }
};
