const axios = require('axios');
const AiBaseClient = require('./aiBaseClient');

// OPENAI CHAT COMPLETIONS API. url IS OPTIONAL - BLANK = api.openai.com,
// SET = ANY OPENAI-COMPATIBLE ENDPOINT (LM STUDIO, VLLM, OPENROUTER...).
const DEFAULT_BASE = 'https://api.openai.com';
const REQUEST_TIMEOUT_MS = 120 * 1000;

class OpenAiAiClient extends AiBaseClient {
  constructor(options) {
    super(options);
    this.serviceLabel = 'OpenAI';
    this.apiKey = options.token;
    this.http = axios.create({
      baseURL: this.baseUrl || DEFAULT_BASE,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${this.apiKey}` }
    });
  }

  get defaultModel() { return 'gpt-5'; }

  async getStatus() {
    try {
      await this.http.get('/v1/models');
      return { version: null };
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async listModels() {
    try {
      const { data } = await this.http.get('/v1/models');
      return (data.data || [])
        .map(model => ({ value: model.id, label: model.id }))
        .sort((a, b) => a.value.localeCompare(b.value));
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async complete({ system, messages, tools = [], maxTokens = 1024 }) {
    const request = {
      model: this.model,
      max_completion_tokens: maxTokens,
      messages: this._messagesOut(system, messages)
    };
    if (tools.length) {
      request.tools = tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
      }));
    }

    let data;
    try {
      ({ data } = await this.http.post('/v1/chat/completions', request));
    } catch (err) {
      // OLDER MODELS/GATEWAYS ONLY TAKE THE LEGACY TOKEN PARAM - ONE RETRY
      if (err.response?.status === 400 && /max_completion_tokens/i.test(JSON.stringify(err.response.data || {}))) {
        const { max_completion_tokens, ...rest } = request;
        try {
          ({ data } = await this.http.post('/v1/chat/completions', { ...rest, max_tokens: maxTokens }));
        } catch (retryErr) {
          throw this._normalizeError(retryErr);
        }
      } else {
        throw this._normalizeError(err);
      }
    }

    const choice = (data.choices || [])[0] || {};
    const message = choice.message || {};
    const blocks = [];
    if (message.content) blocks.push({ type: 'text', text: String(message.content) });
    for (const call of message.tool_calls || []) {
      let input = {};
      try { input = JSON.parse(call.function?.arguments || '{}'); } catch (err) { input = {}; }
      blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
    }
    return {
      blocks,
      stopReason: this._stopReasonOf(choice, blocks),
      usage: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0
      },
      model: data.model || this.model
    };
  }

  // NORMALIZED -> OPENAI WIRE. tool_result BLOCKS BECOME role:'tool'
  // MESSAGES; ASSISTANT tool_use BLOCKS BECOME tool_calls ENTRIES.
  _messagesOut(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const message of messages) {
      if (message.role === 'assistant') {
        const text = AiBaseClient.textOf(message.content);
        const toolCalls = AiBaseClient.toolUsesOf(message.content).map(block => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
        }));
        const entry = { role: 'assistant', content: text || null };
        if (toolCalls.length) entry.tool_calls = toolCalls;
        out.push(entry);
        continue;
      }
      const results = (message.content || []).filter(block => block.type === 'tool_result');
      for (const result of results) {
        out.push({ role: 'tool', tool_call_id: result.tool_use_id, content: String(result.content ?? '') });
      }
      const text = AiBaseClient.textOf(message.content);
      if (text || !results.length) out.push({ role: 'user', content: text });
    }
    return out;
  }

  _stopReasonOf(choice, blocks) {
    if (choice.finish_reason === 'tool_calls' || AiBaseClient.toolUsesOf(blocks).length) return 'tool_use';
    if (choice.finish_reason === 'length') return 'max_tokens';
    return 'end_turn';
  }
}

module.exports = OpenAiAiClient;
