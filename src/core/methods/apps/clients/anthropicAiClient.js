const Anthropic = require('@anthropic-ai/sdk');
const AiBaseClient = require('./aiBaseClient');
const tuning = require('../../../tuning');

// ANTHROPIC (CLAUDE) PROVIDER - THE ONE CLIENT ON THE OFFICIAL SDK; THE
// NORMALIZED BLOCK SHAPE IS ANTHROPIC-NATIVE SO TRANSLATION IS NEARLY 1:1.
// url IS OPTIONAL (PROXY/GATEWAY OVERRIDE) - BLANK MEANS api.anthropic.com.

// ADAPTIVE THINKING EXISTS ON THE 4.6+ FAMILIES; OLDER MODELS WOULD 400 ON
// IT, SO THE PARAM IS ONLY SENT WHERE IT'S UNDERSTOOD (FABLE RUNS ADAPTIVE
// WITH THE PARAM OMITTED EITHER WAY)
const ADAPTIVE_MODELS = /(fable-5|mythos-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;

class AnthropicAiClient extends AiBaseClient {
  constructor(options) {
    super(options);
    this.serviceLabel = 'Anthropic';
    this.apiKey = options.token;
  }

  get defaultModel() { return 'claude-opus-4-8'; }

  _sdk() {
    return new Anthropic({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      timeout: tuning.value('ai_request_timeout_seconds') * 1000
    });
  }

  async getStatus() {
    try {
      await this._sdk().models.list({ limit: 1 });
      return { version: null };
    } catch (err) {
      throw this._normalizeAiError(err);
    }
  }

  async listModels() {
    try {
      const models = [];
      const page = await this._sdk().models.list({ limit: 100 });
      for (const model of page.data || []) {
        models.push({ value: model.id, label: model.display_name || model.id });
      }
      return models;
    } catch (err) {
      throw this._normalizeAiError(err);
    }
  }

  async complete({ system, messages, tools = [], maxTokens = 1024 }) {
    try {
      const request = {
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: messages.map(message => ({
          role: message.role,
          content: message.content.map(block => this._blockOut(block))
        }))
      };
      if (ADAPTIVE_MODELS.test(this.model)) request.thinking = { type: 'adaptive' };
      if (tools.length) {
        request.tools = tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema
        }));
      }

      const response = await this._sdk().messages.create(request);
      return {
        // THE FULL CONTENT LIST RIDES THROUGH (thinking BLOCKS INCLUDED) SO
        // THE LOOP CAN ECHO IT BACK UNCHANGED ON THE TOOL-RESULT TURN
        blocks: response.content,
        stopReason: this._stopReasonOf(response),
        usage: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        model: response.model
      };
    } catch (err) {
      throw this._normalizeAiError(err);
    }
  }

  // NORMALIZED -> WIRE. FOREIGN PROVIDERS NEVER FEED THIS CLIENT MID-LOOP,
  // BUT tool_result CONTENT IS COERCED TO A STRING DEFENSIVELY.
  _blockOut(block) {
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: String(block.content ?? ''),
        ...(block.is_error ? { is_error: true } : {})
      };
    }
    return block;
  }

  _stopReasonOf(response) {
    if (response.stop_reason === 'tool_use') return 'tool_use';
    if (response.stop_reason === 'max_tokens') return 'max_tokens';
    return 'end_turn';
  }

  // SDK ERRORS CARRY status INSTEAD OF AXIOS' response - REMAP SO THE USER
  // SEES THE SAME PRESENTABLE MESSAGES EVERY OTHER CLIENT PRODUCES
  _normalizeAiError(err) {
    let message;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      message = 'Anthropic rejected the configured API key';
    } else if (err instanceof Anthropic.RateLimitError) {
      message = 'Anthropic is rate limiting this key - try again shortly';
    } else if (err instanceof Anthropic.APIConnectionError) {
      message = `Anthropic is unreachable${this.baseUrl ? ` at ${this.baseUrl}` : ''}`;
    } else if (err instanceof Anthropic.APIError) {
      message = `Anthropic responded with HTTP ${err.status}: ${err.message}`;
    } else {
      message = `Anthropic request failed: ${err.message}`;
    }
    const wrapped = new Error(message);
    wrapped.cause = err;
    return wrapped;
  }
}

module.exports = AnthropicAiClient;
