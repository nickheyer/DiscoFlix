const OpenAiAiClient = require('../clients/openaiAiClient');
const { interaction: aiChat, aiProviderFeaturesFor } = require('./interactions/aiChat');

module.exports = {
  id: 'openai',
  label: 'OpenAI',
  icon: '/images/openai.svg',
  blurb: 'GPT - AI assistant for your whole server',
  kind: 'ai-provider',
  envPrefix: 'DF_OPENAI',
  why: 'Wires GPT into the bot and console - also speaks to any OpenAI-compatible endpoint.',
  functions: [
    'Talk to the bot in plain language - @mention, reply, DM, or /chat',
    'Search, request, and check on media conversationally',
    'Ask about queues, streams, requests, and service health',
    'Point it at any OpenAI-compatible endpoint (OpenRouter, LM Studio, vLLM...)'
  ],
  Client: OpenAiAiClient,
  contentTypes: [],
  interactions: [aiChat],
  botFeatures: aiProviderFeaturesFor('openai'),
  configFields: [
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'platform.openai.com → API Keys' },
    { key: 'url', label: 'API Base URL', type: 'string', required: false, placeholder: 'https://api.openai.com (default)', description: 'Optional override for OpenAI-compatible endpoints' }
  ],
  instanceOptions: [
    { key: 'model', label: 'Model', description: 'Which model answers', fetch: 'models', blankLabel: 'gpt-5 (default)' }
  ],
  sections: ['overview', 'chat', 'directives', 'settings'],
  buildClient(row, logger) {
    let settings = {};
    try { settings = JSON.parse(row.settings_json || '{}'); } catch (err) { settings = {}; }
    return new OpenAiAiClient({ url: row.url, token: row.api_key, logger, settings });
  }
};
