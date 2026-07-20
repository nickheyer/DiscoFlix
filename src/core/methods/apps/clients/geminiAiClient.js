const axios = require('axios');
const AiBaseClient = require('./aiBaseClient');
const tuning = require('../../../tuning');

// GOOGLE GEMINI (GENERATIVE LANGUAGE API, v1beta - THE FUNCTION-CALLING
// SURFACE). GEMINI RETURNS NO TOOL-CALL IDS, SO THIS CLIENT SYNTHESIZES
// `name#n` IDS AND PARSES THE NAME BACK OUT WHEN A RESULT RETURNS.
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

// GEMINI'S SCHEMA DIALECT REJECTS JSON-SCHEMA HOUSEKEEPING KEYS
const SCHEMA_KEY_BLOCKLIST = new Set(['additionalProperties', '$schema', 'default']);

function geminiSchemaOf(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchemaOf);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_KEY_BLOCKLIST.has(key)) continue;
    out[key] = geminiSchemaOf(value);
  }
  return out;
}

class GeminiAiClient extends AiBaseClient {
  constructor(options) {
    super(options);
    this.serviceLabel = 'Google Gemini';
    this.apiKey = options.token;
    this.http = axios.create({
      baseURL: this.baseUrl || DEFAULT_BASE,
      // CLIENTS ARE BUILT PER-USE, SO THE TUNED DEADLINE APPLIES LIVE
      timeout: tuning.value('ai_request_timeout_seconds') * 1000,
      headers: { 'x-goog-api-key': this.apiKey }
    });
  }

  get defaultModel() { return 'gemini-2.5-flash'; }

  async getStatus() {
    try {
      await this.http.get('/v1beta/models', { params: { pageSize: 1 } });
      return { version: null };
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async listModels() {
    try {
      const { data } = await this.http.get('/v1beta/models', { params: { pageSize: 200 } });
      return (data.models || [])
        .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
        .map(model => ({
          value: String(model.name || '').replace(/^models\//, ''),
          label: model.displayName || String(model.name || '').replace(/^models\//, '')
        }));
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async complete({ system, messages, tools = [], maxTokens = 1024 }) {
    const request = {
      contents: this._contentsOut(messages),
      generationConfig: { maxOutputTokens: maxTokens }
    };
    if (system) request.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      request.tools = [{
        functionDeclarations: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: geminiSchemaOf(tool.input_schema)
        }))
      }];
    }

    let data;
    try {
      ({ data } = await this.http.post(`/v1beta/models/${this.model}:generateContent`, request));
    } catch (err) {
      throw this._normalizeError(err);
    }

    const candidate = (data.candidates || [])[0] || {};
    const parts = candidate.content?.parts || [];
    const blocks = [];
    let callIndex = 0;
    for (const part of parts) {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      if (part.functionCall) {
        blocks.push({
          type: 'tool_use',
          id: `${part.functionCall.name}#${callIndex++}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {}
        });
      }
    }
    return {
      blocks,
      stopReason: this._stopReasonOf(candidate, blocks),
      usage: {
        input: data.usageMetadata?.promptTokenCount || 0,
        output: data.usageMetadata?.candidatesTokenCount || 0
      },
      model: this.model
    };
  }

  _contentsOut(messages) {
    const contents = [];
    for (const message of messages) {
      const parts = [];
      for (const block of message.content || []) {
        if (block.type === 'text' && block.text) parts.push({ text: block.text });
        else if (block.type === 'tool_use') {
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        } else if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              // THE SYNTHESIZED `name#n` ID CARRIES THE NAME BACK
              name: String(block.tool_use_id || '').split('#')[0],
              response: { result: String(block.content ?? '') }
            }
          });
        }
      }
      if (!parts.length) continue;
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
    return contents;
  }

  _stopReasonOf(candidate, blocks) {
    if (AiBaseClient.toolUsesOf(blocks).length) return 'tool_use';
    if (candidate.finishReason === 'MAX_TOKENS') return 'max_tokens';
    return 'end_turn';
  }
}

module.exports = GeminiAiClient;
