// THE DIRECTIVES TAB (AI PROVIDER TAKEOVERS) - EVERY BLOCK OF TEXT THE APP
// SAYS TO THIS INSTANCE'S LLM, EACH ONE A LIFECYCLE CARD DRESSED LIKE THE
// REQUEST PIPELINE (DIRECTIVE -> WHERE IT LANDS -> WHEN IT FIRES -> TASK
// PERFORMED). CUSTOM TEXT LIVES SPARSE IN settings_json.directives; STOCK
// TEXT IS THE CATALOG DEFAULT, SO RESET IS JUST "FORGET THE OVERRIDE".
const directives = require('../../core/methods/ai/directives');

function slugOf(key) {
  return key.replace(/[^a-zA-Z0-9]+/g, '-');
}

// THE LIFECYCLE STOPS - STAGE 1 REFLECTS CUSTOMIZATION (PULSING WHEN THE
// TEXT IS YOURS), THE REST TRACE WHERE THE DIRECTIVE TRAVELS EVERY TURN
function stagesOf(entry, customized) {
  return [
    {
      label: 'Directive',
      detail: customized ? 'your text' : 'stock text',
      state: customized ? 'active' : 'done'
    },
    entry.group === 'tool'
      ? { label: 'Tool briefing', detail: 'rides the toolbox definition', state: 'done' }
      : { label: 'System prompt', detail: 'assembled fresh each turn', state: 'done' },
    { label: entry.whenLabel, detail: entry.whenDetail, state: 'done' },
    { label: 'Task performed', detail: entry.outcome, state: 'done' }
  ];
}

function directiveViewModel(instance, entry) {
  const custom = directives.customDirectivesOf(instance)[entry.key];
  const customized = typeof custom === 'string' && !!custom.trim() && custom !== entry.defaultText;
  return {
    ...entry,
    slug: slugOf(entry.key),
    customized,
    // RAW TEXT WITH {placeholders} INTACT - THE EDITOR EDITS THE TEMPLATE,
    // INTERPOLATION HAPPENS AT PROMPT TIME
    text: customized ? custom : entry.defaultText,
    stages: stagesOf(entry, customized)
  };
}

function buildDirectivesData(core, instance) {
  const rows = directives.directiveCatalog().map(entry => directiveViewModel(instance, entry));
  return {
    prompt: rows.filter(row => row.group === 'prompt'),
    tools: rows.filter(row => row.group === 'tool'),
    customizedCount: rows.filter(row => row.customized).length
  };
}

// THE DIRECTIVES TAB'S RIGHT RAIL - EVERY {placeholder} THE CATALOG SPEAKS,
// GROUPED BY SCOPE: universal VARS FILL IN EVERY DIRECTIVE OF EVERY FAMILY,
// reply VARS ONLY EXIST WHILE A REPLY IS BEING BUILT (WHICH DIRECTIVES ADD
// THEM DERIVES FROM THE CATALOG'S placeholders ARRAYS SO IT NEVER DRIFTS).
// EMOJI VARS SHOW THE CONSOLE ICON - THE DISCORD-SIDE RENDER IS THE SYNCED
// df_* APPLICATION EMOJI; reply-RESOLVED VARS HAVE NO "NOW" VALUE AT ALL.
async function buildVarsRail(core, instance) {
  const config = await core.models.configuration.get();
  const manifest = core.apps.getType(instance.app_type);
  const NOW = {
    media_server_name: { text: config.media_server_name },
    prefix_keyword: { text: config.prefix_keyword },
    app_name: { text: instance.display_name },
    app_emoji: { icon: manifest.icon, text: `df_${instance.app_type}` },
    discoflix_emoji: { icon: '/images/favicon.png', text: 'df_discoflix' }
  };
  const rows = directives.PLACEHOLDER_DOCS.map(doc => ({
    ...doc,
    usedBy: doc.scope === 'reply'
      ? directives.directiveCatalog()
          .filter(entry => entry.placeholders.includes(doc.key))
          .map(entry => entry.label)
      : [],
    now: NOW[doc.key] || null
  }));
  return {
    universal: rows.filter(row => row.scope === 'universal'),
    reply: rows.filter(row => row.scope === 'reply')
  };
}

// ── ROUTE HANDLERS (AI-PROVIDER-GUARDED) ─────────────────────────────────

async function aiInstanceOf(ctx) {
  const instance = await ctx.core.apps.getInstance(ctx.params.id);
  if (!instance || ctx.core.apps.getType(instance.app_type)?.kind !== 'ai-provider') {
    ctx.status = 404;
    return null;
  }
  return instance;
}

// MERGE-WRITE THE SPARSE OVERRIDE MAP - NEVER TOUCHES SIBLING settings_json
// KEYS (MODEL PICKS ETC.), MIRRORING saveInstanceConfig'S PARTIAL SEMANTICS
async function writeDirective(core, instance, key, text) {
  let settings = {};
  try { settings = JSON.parse(instance.settings_json || '{}'); } catch (err) { settings = {}; }
  const custom = settings.directives && typeof settings.directives === 'object' ? settings.directives : {};
  if (text === null) delete custom[key];
  else custom[key] = text;
  if (Object.keys(custom).length) settings.directives = custom;
  else delete settings.directives;
  await core.models.app.update({ id: instance.id }, { settings_json: JSON.stringify(settings) });
  return core.apps.getInstance(instance.id);
}

async function respondWithDirectiveCard(ctx, instance, entry, message) {
  return ctx.compileView(['apps/sections/aiDirectiveCard.pug', 'extra/notification.pug'], {
    activeApp: instance,
    directive: directiveViewModel(instance, entry),
    message
  });
}

// AUTOSAVE ONE DIRECTIVE. BLANK OR STOCK-IDENTICAL TEXT MEANS "NO OVERRIDE" -
// THE ROW QUIETLY FALLS BACK TO THE CATALOG DEFAULT INSTEAD OF STORING A COPY.
async function saveAiDirective(ctx) {
  const core = ctx.core;
  const instance = await aiInstanceOf(ctx);
  if (!instance) return;
  const entry = directives.getDirective(ctx.params.key);
  if (!entry) {
    ctx.status = 404;
    return;
  }

  const text = String(ctx.request.body?.text ?? '')
    .replace(/\r\n/g, '\n')
    .slice(0, directives.maxDirectiveChars());
  const isStock = !text.trim() || text === entry.defaultText;

  try {
    const fresh = await writeDirective(core, instance, entry.key, isStock ? null : text);
    const message = isStock ? `"${entry.label}" follows the stock text` : `Saved "${entry.label}"`;
    return respondWithDirectiveCard(ctx, fresh, entry, message);
  } catch (err) {
    core.logger.error('DIRECTIVE SAVE FAILED:', err);
    ctx.status = 400;
    ctx.body = { error: err.message };
  }
}

// FORGET THE OVERRIDE - THE CARD COMES BACK WEARING THE STOCK TEXT
async function resetAiDirective(ctx) {
  const core = ctx.core;
  const instance = await aiInstanceOf(ctx);
  if (!instance) return;
  const entry = directives.getDirective(ctx.params.key);
  if (!entry) {
    ctx.status = 404;
    return;
  }
  const fresh = await writeDirective(core, instance, entry.key, null);
  return respondWithDirectiveCard(ctx, fresh, entry, `"${entry.label}" reset to the stock text`);
}

module.exports = {
  buildDirectivesData,
  buildVarsRail,
  saveAiDirective,
  resetAiDirective
};
