const AiBaseClient = require('../apps/clients/aiBaseClient');
const ui = require('../../bot/interactions/ui');

// THE AGENT LOOP + TURN RUNNERS. ONE PROVIDER-NEUTRAL LOOP SERVES BOTH
// SURFACES: DISCORD TURNS RUN WITH THE CALLER'S OWN PERMISSIONS, CONSOLE
// TURNS RUN AS THE OPERATOR. HISTORY REPLAYS AS PLAIN TEXT (TOOL BLOCKS
// LIVE ONLY INSIDE THE IN-FLIGHT LOOP - NO PAIRING/WINDOWING HAZARDS).

const MAX_TOOL_TURNS = 6;
const DISCORD_MAX_TOKENS = 1024;
const CONSOLE_MAX_TOKENS = 2048;
const DEFAULT_CONTEXT_TURNS = 24;
const CONSOLE_CONTEXT_TURNS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// COMPONENTS V2 CAPS A MESSAGE'S TEXT AT 4000 - CHUNK WELL UNDER IT
const DISCORD_CHUNK_CHARS = 3400;
const TYPING_REFRESH_MS = 8 * 1000;

module.exports = {
  // ENABLED + CONFIGURED AI INSTANCES, DEFAULT-FIRST LIKE CONTENT ROUTING
  async servingAiInstances() {
    const rows = await this.core.models.app.getMany(
      { enabled: true },
      {},
      [{ is_default: 'desc' }, { sort_position: 'asc' }, { created_at: 'asc' }]
    );
    return rows.filter(row =>
      this.core.apps.getType(row.app_type)?.kind === 'ai-provider' && this.core.apps.isConfigured(row)
    );
  },

  async defaultAiInstance() {
    return (await this.servingAiInstances())[0] || null;
  },

  // ── SYSTEM PROMPT ──────────────────────────────────────────────────────

  async buildSystemPrompt({ surface, instance, dbUser, guildId }) {
    const core = this.core;
    const config = await core.models.configuration.get();
    const rows = await core.models.app.getMany({ enabled: true });
    const connected = rows
      .filter(row => {
        const manifest = core.apps.getType(row.app_type);
        return manifest && !manifest.hidden && row.id !== instance.id && core.apps.isConfigured(row);
      })
      .map(row => {
        const manifest = core.apps.getType(row.app_type);
        const status = core.apps.statusCache.get(row.id);
        return `- ${row.display_name} (${manifest.label}, ${manifest.kind})${status?.ok === false ? ' [unreachable]' : ''}`;
      });

    const lines = [
      `You are the assistant for "${config.media_server_name}", a personal media server managed through DiscoFlix.`,
      `Today's date is ${new Date().toDateString()}.`,
      '',
      'You help people find, request, and track movies, shows, and music, and answer questions about the server. Your tools are the source of truth - use them for anything factual (what exists, what is downloading, what is new, service health). Never invent library contents or statuses.',
      '',
      connected.length ? `Connected services:\n${connected.join('\n')}` : 'No other services are connected yet - suggest adding apps in the web console when someone asks for things that need them.',
      '',
      'Requesting: search_media first, then request_media with the exact external_id. If the user clearly asked for a title to be added ("request X", "add X", "can you get X"), request it right away. If they were only browsing or asking questions, confirm before requesting. Relay tool denials honestly - permissions belong to the person talking to you.'
    ];

    if (surface === 'discord') {
      const tier = dbUser?.is_superuser ? 'admin' : dbUser?.is_staff ? 'staff' : dbUser?.is_whitelisted ? 'whitelisted member' : 'member';
      lines.push(
        '',
        `You are speaking in Discord${guildId ? ' in a shared channel - user messages are prefixed with [name] so you can tell people apart; address people by name when it helps' : ' in a direct message'}.`,
        `The current speaker is ${dbUser?.display_name || dbUser?.username || 'a member'} (${tier}).`,
        `Bot commands also exist: the prefix keyword is "${config.prefix_keyword}" and slash commands like /movie, /show, /status, /whatsnew - mention them when someone asks how to use the bot.`,
        '',
        'Style: Discord markdown only (bold, italics, `code`, [links](url)). Be conversational and tight - a few sentences for most answers, short lists when listing. Hard limit ~1200 characters; never dump raw JSON.'
      );
    } else {
      lines.push(
        '',
        'You are speaking to the server operator in the DiscoFlix web console. They administer everything, so be direct and complete - you may approve or deny pending requests when asked, and should confirm before deciding anything they did not explicitly name.',
        '',
        'Style: markdown (bold, italics, `code`, [links](url), short headings). Be thorough but structured; never dump raw JSON.'
      );
    }
    return lines.join('\n');
  },

  // ── HISTORY (PLAIN-TEXT REPLAY) ────────────────────────────────────────

  // AiMessage ROWS -> NORMALIZED MESSAGES. DISCORD USER TURNS CARRY [name]
  // ATTRIBUTION; CONSECUTIVE SAME-ROLE TURNS MERGE (EVERY PROVIDER COPES).
  _historyMessagesOf(rows, { attribute = false } = {}) {
    const messages = [];
    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      const text = row.role === 'user' && attribute && row.author_label
        ? `[${row.author_label}] ${row.content}`
        : row.content;
      if (!String(text || '').trim()) continue;
      const last = messages[messages.length - 1];
      if (last && last.role === row.role) {
        last.content[0].text += `\n${text}`;
      } else {
        messages.push({ role: row.role, content: [{ type: 'text', text }] });
      }
    }
    // EVERY PROVIDER WANTS A user TURN FIRST - DROP A LEADING assistant RUN
    while (messages.length && messages[0].role !== 'user') messages.shift();
    return messages;
  },

  // ── THE LOOP ───────────────────────────────────────────────────────────

  async _runAgentLoop({ client, system, history, userText, toolCtx, maxTokens }) {
    const tools = this.aiToolDefinitionsFor(toolCtx);
    const messages = [...history, { role: 'user', content: [{ type: 'text', text: userText }] }];
    const usage = { input: 0, output: 0 };
    const toolsUsed = [];
    let response = null;

    for (let turn = 0; turn <= MAX_TOOL_TURNS; turn++) {
      const exhausted = turn === MAX_TOOL_TURNS;
      response = await client.complete({
        system,
        messages,
        // THE FINAL PASS RUNS BARE SO AN OVER-EAGER MODEL MUST ANSWER
        tools: exhausted ? [] : tools,
        maxTokens
      });
      usage.input += response.usage.input;
      usage.output += response.usage.output;

      const toolUses = AiBaseClient.toolUsesOf(response.blocks);
      if (exhausted || response.stopReason !== 'tool_use' || !toolUses.length) break;

      toolsUsed.push(...toolUses.map(use => use.name));
      this.logger.info(`AI (${toolCtx.instance.display_name}) calling tools: ${toolUses.map(use => use.name).join(', ')}`);

      // ASSISTANT BLOCKS ECHO BACK VERBATIM (PROVIDER EXTRAS INCLUDED), THEN
      // EVERY RESULT RETURNS IN ONE USER TURN - PARALLEL CALLS STAY PARALLEL
      messages.push({ role: 'assistant', content: response.blocks });
      const results = await Promise.all(toolUses.map(use => this.executeAiTool(toolCtx, use)));
      messages.push({ role: 'user', content: results });
    }

    const text = AiBaseClient.textOf(response.blocks)
      || "I couldn't put an answer together for that - try rephrasing?";
    return { text, usage, toolsUsed: [...new Set(toolsUsed)], model: response.model };
  },

  // PER-THREAD SERIALIZATION - SIMULTANEOUS TURNS QUEUE INSTEAD OF RACING
  _withThreadLock(conversationId, task) {
    if (!this._threadLocks) this._threadLocks = new Map();
    const previous = this._threadLocks.get(conversationId) || Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => {});
    this._threadLocks.set(conversationId, tail);
    tail.then(() => {
      if (this._threadLocks.get(conversationId) === tail) this._threadLocks.delete(conversationId);
    });
    return next;
  },

  // ── DISCORD TURNS ──────────────────────────────────────────────────────

  async runDiscordTurn(ctx, instance, text) {
    const core = this.core;
    const extents = ctx.feature?.extents || {};

    // DAILY MESSAGE CAP (0 = UNLIMITED, staff+ EXEMPT VIA adminExempt)
    const dailyLimit = Number(extents.max_messages_per_day) || 0;
    if (dailyLimit > 0) {
      const count = await core.models.aiMessage.countAuthoredSince(
        ctx.discordUser.id, new Date(Date.now() - DAY_MS)
      );
      if (count >= dailyLimit) {
        await ctx.send(ui.notice(
          `You've used your ${dailyLimit} AI message${dailyLimit === 1 ? '' : 's'} for today - try again tomorrow.`,
          { accent: 'danger' }
        ));
        return;
      }
    }

    // SLASH FLOWS ALREADY SHOW "THINKING..." VIA THE DEFERRED REPLY; PREFIX/
    // MENTION FLOWS GET A LIVE TYPING INDICATOR FOR THE LOOP'S LIFETIME
    let typingTimer = null;
    if (ctx.source !== 'slash' && ctx.channel?.sendTyping) {
      ctx.channel.sendTyping().catch(() => {});
      typingTimer = setInterval(() => ctx.channel.sendTyping().catch(() => {}), TYPING_REFRESH_MS);
    }

    try {
      const client = core.apps.getClientForInstance(instance);
      const thread = await core.models.aiConversation.threadForDiscordChannel(instance.id, ctx.channel.id);
      if (thread.title === 'Discord channel thread' && ctx.channel.name) {
        await core.models.aiConversation.update({ id: thread.id }, { title: `#${ctx.channel.name}` }).catch(() => {});
      }

      const authorLabel = ctx.discordUser.displayName || ctx.discordUser.username;
      const contextTurns = Number(extents.context_turns) || DEFAULT_CONTEXT_TURNS;

      const result = await this._withThreadLock(thread.id, async () => {
        const window = await core.models.aiMessage.windowFor(thread.id, contextTurns);
        const history = this._historyMessagesOf(window, { attribute: true });
        await core.models.aiMessage.append(thread.id, {
          role: 'user', content: text, authorLabel, authorKey: ctx.discordUser.id
        });

        const system = await this.buildSystemPrompt({
          surface: 'discord', instance, dbUser: ctx.dbUser, guildId: ctx.guildId
        });
        const toolCtx = {
          core, surface: 'discord', instance,
          dbUser: ctx.dbUser, roleTokens: ctx.roleTokens, guildId: ctx.guildId,
          channel: ctx.channel, messageId: ctx.messageId, origContent: text
        };
        const outcome = await this._runAgentLoop({
          client, system,
          history,
          userText: `[${authorLabel}] ${text}`,
          toolCtx,
          maxTokens: DISCORD_MAX_TOKENS
        });
        await core.models.aiMessage.append(thread.id, {
          role: 'assistant', content: outcome.text,
          blocks: { toolsUsed: outcome.toolsUsed, model: outcome.model },
          authorLabel: instance.display_name, usage: outcome.usage
        });
        await core.models.aiConversation.touch(thread.id);
        return outcome;
      });

      await this._sendDiscordReply(ctx, instance, result);
    } catch (err) {
      core.logger.error('AI chat turn failed:', err);
      await ctx.send(ui.notice(`The assistant hit a snag: ${err.message}`, { accent: 'danger' })).catch(() => {});
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  },

  // FINAL TEXT -> CV2 CONTAINERS, CHUNKED UNDER THE PER-MESSAGE TEXT CAP.
  // THE LAST CHUNK CARRIES THE PROVIDER/TOOL ATTRIBUTION SUBTEXT.
  async _sendDiscordReply(ctx, instance, { text, toolsUsed, model }) {
    const chunks = this._chunkText(text, DISCORD_CHUNK_CHARS);
    const meta = [`-# ${instance.display_name}`, model ? model : null,
      toolsUsed.length ? `used ${toolsUsed.join(', ')}` : null
    ].filter(Boolean).join(' • ');

    for (let i = 0; i < chunks.length; i++) {
      const parts = [ui.text(chunks[i])];
      if (i === chunks.length - 1) parts.push(ui.text(meta));
      const payload = ui.payload(ui.container(parts));
      if (i === 0) await ctx.send(payload);
      else await ctx.channel.send(payload);
    }
  },

  _chunkText(text, size) {
    const chunks = [];
    let rest = String(text || '').trim();
    while (rest.length > size) {
      // PREFER A PARAGRAPH SEAM, THEN A LINE, THEN A WORD
      let cut = rest.lastIndexOf('\n\n', size);
      if (cut < size / 2) cut = rest.lastIndexOf('\n', size);
      if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
      if (cut < size / 2) cut = size;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.length ? chunks : ['...'];
  },

  // ── CONSOLE TURNS ──────────────────────────────────────────────────────

  // RUNS THE OPERATOR TURN AND RETURNS THE PERSISTED ASSISTANT ROW - THE
  // ROUTE LAYER RENDERS/BROADCASTS IT (fire-and-forget AFTER THE HTTP ACK).
  // onUserPersisted FIRES THE MOMENT THE OPERATOR ROW LANDS SO THE BUBBLE
  // CAN PAINT WHILE THE LOOP RUNS.
  async runConsoleTurn(instance, conversationId, text, { onUserPersisted = null } = {}) {
    const core = this.core;
    const client = core.apps.getClientForInstance(instance);
    if (!client) throw new Error(`${instance.display_name} is not fully configured`);

    return this._withThreadLock(conversationId, async () => {
      const window = await core.models.aiMessage.windowFor(conversationId, CONSOLE_CONTEXT_TURNS);
      const history = this._historyMessagesOf(window);
      const userRow = await core.models.aiMessage.append(conversationId, {
        role: 'user', content: text, authorLabel: 'Operator', authorKey: 'console'
      });
      await core.models.aiConversation.adoptTitle(conversationId, text);
      if (onUserPersisted) {
        try { await onUserPersisted(userRow); } catch (err) {
          this.logger.debug(`AI user-row push failed: ${err.message}`);
        }
      }

      let assistantRow;
      try {
        const system = await this.buildSystemPrompt({ surface: 'console', instance, dbUser: null, guildId: null });
        const toolCtx = {
          core, surface: 'console', instance,
          dbUser: null, roleTokens: [], guildId: null,
          channel: null, messageId: null, origContent: text
        };
        const outcome = await this._runAgentLoop({
          client, system, history, userText: text, toolCtx, maxTokens: CONSOLE_MAX_TOKENS
        });
        assistantRow = await core.models.aiMessage.append(conversationId, {
          role: 'assistant', content: outcome.text,
          blocks: { toolsUsed: outcome.toolsUsed, model: outcome.model },
          authorLabel: instance.display_name, usage: outcome.usage
        });
      } catch (err) {
        core.logger.error('AI console turn failed:', err);
        assistantRow = await core.models.aiMessage.append(conversationId, {
          role: 'assistant',
          content: `I couldn't reach the provider: ${err.message}`,
          authorLabel: instance.display_name,
          error: err.message
        });
      }
      await core.models.aiConversation.touch(conversationId);
      return { userRow, assistantRow };
    });
  }
};
