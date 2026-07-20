const axios = require('axios');
const AiBaseClient = require('./aiBaseClient');
const tuning = require('../../../tuning');

// OLLAMA - THE LOCAL/SELF-HOSTED PROVIDER. NO API KEY, JUST A URL. TOOL
// CALLING RIDES /api/chat (MODERN OLLAMA + A TOOL-CAPABLE MODEL); MODELS
// WITHOUT TOOL SUPPORT STILL CHAT - OLLAMA JUST NEVER EMITS tool_calls.

class OllamaAiClient extends AiBaseClient {
  constructor(options) {
    super(options);
    this.serviceLabel = 'Ollama';
    // LOCAL MODELS CAN BE SLOW - OLLAMA GETS ITS OWN TUNED DEADLINE, READ
    // PER-BUILD (CLIENTS ARE BUILT PER-USE) SO ADMIN CHANGES APPLY LIVE
    this.http = axios.create({ baseURL: this.baseUrl, timeout: tuning.value('ollama_request_timeout_seconds') * 1000 });
  }

  get defaultModel() { return String(this.instanceSettings.model || '').trim(); }

  // BLANK MODEL PICK FALLS BACK TO THE FIRST INSTALLED TAG AT CALL TIME
  async _resolveModel() {
    if (this.model) return this.model;
    const models = await this.listModels();
    if (!models.length) throw new Error('Ollama has no models installed - `ollama pull` one first');
    return models[0].value;
  }

  async getStatus() {
    try {
      const { data } = await this.http.get('/api/version');
      return { version: data.version || null };
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async listModels() {
    try {
      const { data } = await this.http.get('/api/tags');
      return (data.models || []).map(model => ({ value: model.name, label: model.name }));
    } catch (err) {
      throw this._normalizeError(err);
    }
  }

  async complete({ system, messages, tools = [], maxTokens = 1024 }) {
    const model = await this._resolveModel();
    const request = {
      model,
      stream: false,
      messages: this._messagesOut(system, messages),
      options: { num_predict: maxTokens }
    };
    if (tools.length) {
      request.tools = tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
      }));
    }

    let data;
    try {
      ({ data } = await this.http.post('/api/chat', request));
    } catch (err) {
      // A MODEL WITHOUT TOOL SUPPORT 400s ON tools - RETRY BARE SO CHAT
      // STILL WORKS, THE MODEL JUST CAN'T ACT
      if (tools.length && err.response?.status === 400) {
        const { tools: dropped, ...bare } = request;
        try {
          ({ data } = await this.http.post('/api/chat', bare));
        } catch (retryErr) {
          throw this._normalizeError(retryErr);
        }
      } else {
        throw this._normalizeError(err);
      }
    }

    const message = data.message || {};
    const blocks = [];
    if (message.content) blocks.push({ type: 'text', text: String(message.content) });
    let callIndex = 0;
    for (const call of message.tool_calls || []) {
      blocks.push({
        type: 'tool_use',
        id: `${call.function?.name}#${callIndex++}`,
        name: call.function?.name,
        input: call.function?.arguments || {}
      });
    }
    return {
      blocks,
      stopReason: this._stopReasonOf(data, blocks),
      usage: {
        input: data.prompt_eval_count || 0,
        output: data.eval_count || 0
      },
      model
    };
  }

  _messagesOut(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const message of messages) {
      if (message.role === 'assistant') {
        const entry = { role: 'assistant', content: AiBaseClient.textOf(message.content) };
        const toolCalls = AiBaseClient.toolUsesOf(message.content).map(block => ({
          function: { name: block.name, arguments: block.input || {} }
        }));
        if (toolCalls.length) entry.tool_calls = toolCalls;
        out.push(entry);
        continue;
      }
      const results = (message.content || []).filter(block => block.type === 'tool_result');
      for (const result of results) {
        out.push({ role: 'tool', content: String(result.content ?? '') });
      }
      const text = AiBaseClient.textOf(message.content);
      if (text || !results.length) out.push({ role: 'user', content: text });
    }
    return out;
  }

  _stopReasonOf(data, blocks) {
    if (AiBaseClient.toolUsesOf(blocks).length) return 'tool_use';
    if (data.done_reason === 'length') return 'max_tokens';
    return 'end_turn';
  }
}

module.exports = OllamaAiClient;
