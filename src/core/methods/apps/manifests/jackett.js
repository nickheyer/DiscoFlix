const JackettClient = require('../clients/jackettClient');

module.exports = {
  id: 'jackett',
  label: 'Jackett',
  icon: '/images/jackett.svg',
  blurb: 'Torrent indexer proxy for the arrs',
  kind: 'indexer',
  why: 'The search backbone behind the arrs - query and grab from it directly.',
  functions: [
    'Search every configured indexer at once',
    'Send any release straight to a connected torrent client',
    'Indexer roster with per-tracker error warnings',
    'Connection and API-key health on the rail'
  ],
  Client: JackettClient,
  contentTypes: [],
  browseLabel: 'release',
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:9117', description: 'Base URL of the Jackett server' },
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'The API Key shown on the Jackett dashboard' }
  ],
  sections: ['overview', 'releases', 'settings'],
  buildClient(row, logger) {
    return new JackettClient({ url: row.url, apiKey: row.api_key, logger });
  }
};
