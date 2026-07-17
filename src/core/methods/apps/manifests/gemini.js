const GeminiAiClient = require('../clients/geminiAiClient');
const { interaction: aiChat, aiProviderFeaturesFor } = require('./interactions/aiChat');

module.exports = {
  id: 'gemini',
  label: 'Google Gemini',
  icon: '/images/gemini.svg',
  blurb: 'Gemini - AI assistant for your whole server',
  kind: 'ai-provider',
  envPrefix: 'DF_GEMINI',
  why: 'Wires Gemini into the bot and console - a natural-language front door to every connected app.',
  functions: [
    'Talk to the bot in plain language - @mention, reply, DM, or /chat',
    'Search, request, and check on media conversationally',
    'Ask about queues, streams, requests, and service health',
    'A full operator chat in the console with persistent threads'
  ],
  Client: GeminiAiClient,
  contentTypes: [],
  interactions: [aiChat],
  botFeatures: aiProviderFeaturesFor('gemini'),
  configFields: [
    { key: 'api_key', label: 'API Key', type: 'string', required: true, sensitive: true, description: 'aistudio.google.com → Get API key' }
  ],
  instanceOptions: [
    { key: 'model', label: 'Model', description: 'Which Gemini model answers', fetch: 'models', blankLabel: 'Gemini 2.5 Flash (default)' }
  ],
  sections: ['overview', 'chat', 'directives', 'settings'],
  buildClient(row, logger) {
    let settings = {};
    try { settings = JSON.parse(row.settings_json || '{}'); } catch (err) { settings = {}; }
    return new GeminiAiClient({ url: row.url, token: row.api_key, logger, settings });
  }
};
