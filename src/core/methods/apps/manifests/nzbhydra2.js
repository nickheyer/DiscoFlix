const Nzbhydra2Client = require('../clients/nzbhydra2Client');

module.exports = {
  id: 'nzbhydra2',
  label: 'NZBHydra2',
  icon: '/images/nzbhydra2.svg',
  blurb: 'Meta search for usenet indexers',
  kind: 'indexer',
  why: 'The search backbone behind the arrs - query and grab from it directly.',
  functions: [
    'Meta search across every wrapped indexer at once',
    'Send any release straight to a connected download client',
    'Connection and API-key health on the rail'
  ],
  Client: Nzbhydra2Client,
  contentTypes: [],
  browseLabel: 'release',
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:5076', description: 'Base URL of the NZBHydra2 server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'Config → Main → API key' }
  ],
  sections: ['overview', 'releases', 'settings'],
  buildClient(row, logger) {
    return new Nzbhydra2Client({ url: row.url, apiKey: row.api_key, logger });
  }
};
