const OllamaAiClient = require('../clients/ollamaAiClient');
const { interaction: aiChat, aiProviderFeaturesFor } = require('./interactions/aiChat');

module.exports = {
  id: 'ollama',
  label: 'Ollama',
  icon: '/images/ollama.svg',
  blurb: 'Local models - private AI on your own hardware',
  kind: 'ai-provider',
  envPrefix: 'DF_OLLAMA',
  why: 'A fully local AI assistant - nothing leaves your network, no API key required.',
  functions: [
    'Talk to the bot in plain language - @mention, reply, DM, or /chat',
    'Search, request, and check on media conversationally',
    'Runs entirely on your own hardware - no cloud, no key',
    'Tool calling works with tool-capable models (llama3.1+, qwen, mistral...)'
  ],
  Client: OllamaAiClient,
  contentTypes: [],
  interactions: [aiChat],
  botFeatures: aiProviderFeaturesFor('ollama'),
  configFields: [
    { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'http://localhost:11434', description: 'Base URL of the Ollama server' }
  ],
  instanceOptions: [
    { key: 'model', label: 'Model', description: 'Which installed model answers', fetch: 'models', blankLabel: 'First installed model (default)' }
  ],
  sections: ['overview', 'chat', 'directives', 'settings'],
  buildClient(row, logger) {
    let settings = {};
    try { settings = JSON.parse(row.settings_json || '{}'); } catch (err) { settings = {}; }
    return new OllamaAiClient({ url: row.url, logger, settings });
  }
};
