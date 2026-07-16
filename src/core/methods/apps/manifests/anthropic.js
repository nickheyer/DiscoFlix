const AnthropicAiClient = require('../clients/anthropicAiClient');

module.exports = {
  id: 'anthropic',
  label: 'Anthropic',
  icon: '/images/anthropic.svg',
  blurb: 'Claude - AI assistant for your whole server',
  kind: 'ai-provider',
  envPrefix: 'DF_ANTHROPIC',
  why: 'Wires Claude into the bot and console - a natural-language front door to every connected app.',
  functions: [
    'Talk to the bot in plain language - @mention, reply, DM, or /chat',
    'Search, request, and check on media conversationally',
    'Ask about queues, streams, requests, and service health',
    'A full operator chat in the console with persistent threads'
  ],
  Client: AnthropicAiClient,
  contentTypes: [],
  interactions: [require('./interactions/aiChat')],
  configFields: [
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'console.anthropic.com → API Keys' },
    { key: 'url', label: 'API Base URL', type: 'string', required: false, placeholder: 'https://api.anthropic.com (default)', description: 'Optional gateway/proxy override - leave blank for the Anthropic API' }
  ],
  instanceOptions: [
    { key: 'model', label: 'Model', description: 'Which Claude model answers', fetch: 'models', blankLabel: 'Claude Opus 4.8 (default)' }
  ],
  sections: ['overview', 'chat', 'settings'],
  buildClient(row, logger) {
    let settings = {};
    try { settings = JSON.parse(row.settings_json || '{}'); } catch (err) { settings = {}; }
    return new AnthropicAiClient({ url: row.url, token: row.api_key, logger, settings });
  }
};
