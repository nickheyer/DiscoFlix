const AiBaseClient = require('../apps/clients/aiBaseClient');
const ui = require('../../bot/interactions/ui');
const { appEmoji } = require('../../bot/interactions/appEmojis');
const { directiveText } = require('./directives');

// THE AGENT LOOP + TURN RUNNERS. ONE PROVIDER-NEUTRAL LOOP SERVES BOTH
// SURFACES: DISCORD TURNS RUN WITH THE CALLER'S OWN PERMISSIONS, CONSOLE
// TURNS RUN AS THE OPERATOR. HISTORY REPLAYS AS PLAIN TEXT (TOOL BLOCKS
// LIVE ONLY INSIDE THE IN-FLIGHT LOOP - NO PAIRING/WINDOWING HAZARDS).

const MAX_TOOL_TURNS = 6;
const DISCORD_MAX_TOKENS = 1024;
const CONSOLE_MAX_TOKENS = 2048;
const DEFAULT_CONTEXT_TURNS = 24;
// DISCORD SESSIONS END NATURALLY - A CHANNEL QUIET THIS LONG STARTS FRESH
// (0 VIA THE context_idle_hours EXTENT = MEMORY NEVER FADES). CONSOLE
// THREADS ARE EXPLICIT SESSIONS AND NEVER IDLE-CUT.
const DEFAULT_IDLE_HOURS = 8;
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

  // ── DOOR ROUTING ───────────────────────────────────────────────────────

  // WHO ANSWERS A DISCORD DOOR (commands | mentions | dms): WALK THE SERVING
  // PROVIDERS DEFAULT-FIRST AND TAKE THE FIRST WHOSE OWN (PROVIDER, DOOR)
  // MATRIX ROW ADMITS THIS CALLER AT THIS SCOPE - DISABLING A ROW ROUTES
  // AROUND THAT PROVIDER, AUDIENCES CAN TIER PROVIDERS PER DOOR. NO WINNER:
  // gate CARRIES THE FIRST DENIAL (NULL WHEN NOTHING SERVES AT ALL) SO THE
  // CALLER CAN ANSWER HONESTLY.
  async resolveAiDoor(ctx, door) {
    const features = require('../../bot/interactions/features');
    const { aiDoorFeatureId } = require('../apps/manifests/interactions/aiChat');
    const instances = await this.servingAiInstances();
    let denial = null;
    for (const instance of instances) {
      const gate = await features.resolveFeature(this.core, aiDoorFeatureId(instance.app_type, door), ctx);
      if (gate.allowed) return { instance, gate };
      // AN AUDIENCE DENIAL ("ASK AN ADMIN") IS ACTIONABLE; "SWITCHED OFF"
      // ISN'T - REPORT THE MOST USEFUL NO WHEN EVERY DOOR STAYS SHUT
      if (!denial || (denial.reason !== 'audience' && gate.reason === 'audience')) denial = gate;
    }
    return { instance: null, gate: denial };
  },

  // ── SYSTEM PROMPT ──────────────────────────────────────────────────────

  // EVERY STATIC BLOCK COMES THROUGH THE DIRECTIVE CATALOG (DEFAULTS ARE THE
  // TEXT THAT USED TO LIVE HERE; THE DIRECTIVES TAB OVERRIDES PER INSTANCE).
  // DYNAMIC LINES - DATE, CONNECTED SERVICES, SPEAKER CONTEXT - STAY BUILT.
  // dossier IS THE SPEAKER'S PRE-BUILT DATA BLOCK (_buildSpeakerDossier),
  // PRESENT ONLY WHEN THE PROVIDER'S "PERSONALIZED REPLIES" ROW ADMITTED
  // THE CALLER - ABSENT, THE PROMPT IS EXACTLY WHAT IT ALWAYS WAS.
  async buildSystemPrompt({ surface, instance, dbUser, guildId, dossier = null }) {
    const core = this.core;
    const config = await core.models.configuration.get();
    const say = key => directiveText(instance, key, {
      media_server_name: config.media_server_name,
      prefix_keyword: config.prefix_keyword
    });
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
      say('identity'),
      `Today's date is ${new Date().toDateString()}.`,
      '',
      say('mission'),
      '',
      connected.length ? `Connected services:\n${connected.join('\n')}` : say('no_services'),
      '',
      say('requesting')
    ];

    if (surface === 'discord') {
      const tier = dbUser?.is_superuser ? 'admin' : dbUser?.is_staff ? 'staff' : dbUser?.is_whitelisted ? 'whitelisted member' : 'member';
      lines.push(
        '',
        `You are speaking in Discord${guildId ? ' in a shared channel - user messages are prefixed with [name] so you can tell people apart; address people by name when it helps' : ' in a direct message'}.`,
        `The current speaker is ${dbUser?.display_name || dbUser?.username || 'a member'} (${tier}).`
      );
      // THE DOSSIER RIDES RIGHT UNDER THE SPEAKER LINE, CHAPERONED BY ITS
      // DIRECTIVE (HOW TO WEIGH IT, WHAT NEVER TO RECITE)
      if (dossier) lines.push('', dossier, '', say('dossier'), '');
      lines.push(say('discord_manner'));
    } else {
      lines.push('', say('console_manner'));
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

    // DAILY MESSAGE CAP (0 = UNLIMITED, staff+ EXEMPT VIA adminExempt) -
    // SCOPED TO THIS PROVIDER TYPE, EACH ROW'S BUDGET IS ITS OWN
    const dailyLimit = Number(extents.max_messages_per_day) || 0;
    if (dailyLimit > 0) {
      const count = await core.models.aiMessage.countAuthoredSince(
        ctx.discordUser.id, new Date(Date.now() - DAY_MS), instance.app_type
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
      // 0 STAYS 0 (NEVER FADES) - ONLY AN ABSENT EXTENT FALLS TO THE DEFAULT
      const idleHoursRaw = Number(extents.context_idle_hours);
      const idleHours = Number.isFinite(idleHoursRaw) ? idleHoursRaw : DEFAULT_IDLE_HOURS;

      const result = await this._withThreadLock(thread.id, async () => {
        const window = await core.models.aiMessage.windowFor(thread.id, contextTurns, {
          idleMs: idleHours > 0 ? idleHours * 60 * 60 * 1000 : 0
        });
        const history = this._historyMessagesOf(window, { attribute: true });
        await core.models.aiMessage.append(thread.id, {
          role: 'user', content: text, authorLabel, authorKey: ctx.discordUser.id
        });

        const system = await this.buildSystemPrompt({
          surface: 'discord', instance, dbUser: ctx.dbUser, guildId: ctx.guildId,
          dossier: await this._buildSpeakerDossier(ctx, instance)
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

  // THE SPEAKER'S DOSSIER - OPERATOR NOTES + RECENT REQUEST HISTORY, GATED
  // BY THE PROVIDER'S "PERSONALIZED REPLIES" MATRIX ROW (OFF BY DEFAULT;
  // AUDIENCE PICKS WHOSE DOSSIER MAY BE READ). RETURNS NULL WHEN THE GATE
  // SAYS NO OR THERE IS NOTHING WORTH SAYING - THE PROMPT STAYS UNCHANGED.
  async _buildSpeakerDossier(ctx, instance) {
    if (!ctx.dbUser) return null;
    const features = require('../../bot/interactions/features');
    const { aiDossierFeatureId } = require('../apps/manifests/interactions/aiChat');
    const gate = await features.resolveFeature(this.core, aiDossierFeatureId(instance.app_type), ctx);
    if (!gate.allowed) return null;

    const lines = ['About the current speaker:'];
    const notes = String(ctx.dbUser.notes || '').trim();
    if (notes) lines.push(`- Operator notes: ${notes.slice(0, 400)}`);

    // 0 = NO HISTORY (JUST NOTES) - A take-LIMIT IS THE ONE EXTENT WHERE
    // "UNLIMITED" WOULD BE A PROMPT-STUFFING FOOTGUN
    const historyItems = Number(gate.extents.history_items) || 0;
    if (historyItems > 0) {
      const [total, rows] = await Promise.all([
        this.core.models.mediaRequest.countUserRequests(ctx.dbUser.id),
        this.core.models.mediaRequest.getUserRequests(ctx.dbUser.id, {}, { take: historyItems })
      ]);
      if (total > 0) {
        const items = rows.map(row => {
          const title = row.media?.title || row.orig_parsed_title || 'unknown';
          const state = row.status === null
            ? 'pending approval'
            : row.status ? (row.media?.is_available ? 'downloaded' : 'approved') : 'denied';
          return `${title} (${state})`;
        });
        lines.push(`- Their requests: ${total} total; latest: ${items.join(', ')}`);
      }
    }
    return lines.length > 1 ? lines.join('\n') : null;
  },

  // FINAL TEXT -> CV2 CONTAINERS, CHUNKED UNDER THE PER-MESSAGE TEXT CAP.
  // THE LAST CHUNK CLOSES WITH A FOOTER: DIVIDER, THEN THE discord_footer
  // DIRECTIVE AS SUBTEXT - A PER-INSTANCE TEMPLATE ({app_emoji}, {model},
  // {tools_used}, ...), PURE PRESENTATION AND NEVER PROMPTED.
  async _sendDiscordReply(ctx, instance, { text, toolsUsed, model }) {
    const chunks = this._chunkText(this._discordifyMarkdown(text), DISCORD_CHUNK_CHARS);
    const footer = directiveText(instance, 'discord_footer', {
      // THE BRAND EMOJI, OR THE PLAIN NAME UNTIL AN EMOJI SYNC LANDS
      app_emoji: appEmoji(instance.app_type) || instance.display_name,
      app_name: instance.display_name,
      model: model || '',
      tools_used: toolsUsed.map(name => name.replace(/_/g, ' ')).join(', '),
      prefix_keyword: ctx.config?.prefix_keyword || ''
    }).split('\n').map(line => `-# ${line}`).join('\n');

    for (let i = 0; i < chunks.length; i++) {
      const parts = [ui.text(chunks[i])];
      if (i === chunks.length - 1) parts.push(ui.separator(), ui.text(footer));
      const payload = ui.payload(ui.container(parts));
      if (i === 0) await ctx.send(payload);
      else await ctx.channel.send(payload);
    }
  },

  // MODELS EMIT GITHUB-ISH MARKDOWN; DISCORD RENDERS A SUBSET. HEADINGS
  // DEMOTE TO ### (A CHAT REPLY NEVER SHOUTS; H4+ WOULD RENDER AS LITERAL
  // HASHES), PIPE TABLES BECOME BOLD-LED LINES, HORIZONTAL RULES DROP (THE
  // CONTAINER ALREADY FRAMES THE MESSAGE). CODE FENCES PASS THROUGH RAW.
  _discordifyMarkdown(text) {
    return String(text || '')
      .split(/(```[\s\S]*?```)/)
      .map((segment, i) => {
        if (i % 2 === 1) return segment;
        const cleaned = segment
          .replace(/^#{1,3}\s+(.+)$/gm, '### $1')
          .replace(/^#{4,6}\s+(.+)$/gm, '**$1**')
          .replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '');
        return this._flattenTables(cleaned).replace(/\n{3,}/g, '\n\n');
      })
      .join('');
  },

  // | A | B | PIPE TABLES -> A -# HEADER LINE PLUS ONE BOLD-LED LINE PER ROW
  _flattenTables(segment) {
    const isRow = line => /^\s*\|.+\|\s*$/.test(line);
    const isDivider = line => /^\s*\|[\s:|-]+\|\s*$/.test(line || '');
    const cellsOf = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

    const lines = segment.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isRow(lines[i]) || !isDivider(lines[i + 1])) {
        out.push(lines[i]);
        continue;
      }
      out.push(`-# ${cellsOf(lines[i]).join(' · ')}`);
      i += 1;
      while (i + 1 < lines.length && isRow(lines[i + 1]) && !isDivider(lines[i + 1])) {
        i += 1;
        const cells = cellsOf(lines[i]);
        out.push(`**${cells[0]}**${cells.length > 1 ? ` — ${cells.slice(1).join(' · ')}` : ''}`);
      }
    }
    return out.join('\n');
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

    // A CUT MID-CODE-FENCE WOULD GARBLE EVERY CHUNK AFTER IT - CLOSE THE
    // FENCE AT THE SEAM AND REOPEN IT IN THE NEXT CHUNK
    let open = false;
    for (let i = 0; i < chunks.length; i++) {
      if (open) chunks[i] = `\`\`\`\n${chunks[i]}`;
      const fences = (chunks[i].match(/```/g) || []).length;
      open = fences % 2 === 1;
      if (open) chunks[i] += '\n```';
    }
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
