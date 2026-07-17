const BaseClient = require('./baseClient');

// COMMON CONTRACT FOR EVERY AI PROVIDER CLIENT (ANTHROPIC/OPENAI/GEMINI/
// OLLAMA). PROVIDERS SPEAK ONE NORMALIZED SHAPE SO THE AGENT LOOP IN
// core.ai NEVER BRANCHES ON app_type:
//
// complete({ system, messages, tools, maxTokens }) -> {
//   blocks, stopReason ('end_turn'|'tool_use'|'max_tokens'), usage: { input,
//   output }, model }
//
// messages ARE [{ role: 'user'|'assistant', content: [block...] }] WHERE A
// block IS ONE OF:
//   { type: 'text', text }
//   { type: 'tool_use', id, name, input }            (ASSISTANT ONLY)
//   { type: 'tool_result', tool_use_id, content, is_error? } (USER ONLY)
// PROVIDERS MAY RETURN EXTRA BLOCK TYPES OF THEIR OWN (E.G. ANTHROPIC
// thinking BLOCKS) - THE LOOP ECHOES ASSISTANT BLOCKS BACK VERBATIM AND
// EVERY PROVIDER MUST TOLERATE (OR STRIP) TYPES IT DOESN'T KNOW.
//
// tools ARE [{ name, description, input_schema }] (JSON SCHEMA) - EACH
// PROVIDER TRANSLATES TO ITS OWN FUNCTION-CALLING WIRE FORMAT.
//
// listModels() -> [{ value, label }] FEEDS THE SETTINGS MODEL PICKER;
// getStatus() -> { version } IS THE HEARTBEAT/OVERVIEW REACHABILITY CHECK.
class AiBaseClient extends BaseClient {
  constructor({ url, logger, settings = {} }) {
    super({ url, logger });
    this.serviceLabel = 'AI provider';
    this.instanceSettings = settings;
  }

  // BLANK MODEL PICK = THE PROVIDER'S DEFAULT (SUBCLASS CONSTANT)
  get model() {
    return String(this.instanceSettings.model || '').trim() || this.defaultModel;
  }

  get defaultModel() { throw new Error('NOT_IMPLEMENTED'); }

  async listModels() { throw new Error('NOT_IMPLEMENTED'); }
  async complete() { throw new Error('NOT_IMPLEMENTED'); }

  // AI PROVIDERS SERVE CHAT ONLY - EVERY MEDIA-SHAPED SURFACE STAYS OFF
  get capabilities() {
    return { ...super.capabilities, aiChat: true };
  }

  // QUEUE CONTRACT STUBS - THE HEARTBEAT ASKS EVERY CONFIGURED INSTANCE
  async getQueue() { return []; }
  async getHistory() { return { rows: [], hasMore: false }; }

  // FLAT TEXT OF A NORMALIZED BLOCK LIST
  static textOf(blocks) {
    return (blocks || [])
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n')
      .trim();
  }

  static toolUsesOf(blocks) {
    return (blocks || []).filter(block => block.type === 'tool_use');
  }
}

module.exports = AiBaseClient;
