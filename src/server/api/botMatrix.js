// THE DISCORD BOT TAB - BOT IDENTITY + AUDIENCE MAPPING (THE SIX CONFIG
// FIELDS THAT MOVED OFF dfSettings) AND THE FEATURE MATRIX: EVERY FEATURE
// THE BOT OFFERS, GROUPED BY THE APP THAT PROVIDES IT, WITH PER-FEATURE
// AUDIENCE GRANTS AND EXTENTS, GLOBALLY OR PER DISCORD SERVER.
const features = require('../../core/bot/interactions/features');
const { AI_DOORS } = require('../../core/methods/apps/manifests/interactions/aiChat');

const AUDIENCE_OPTIONS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'whitelisted', label: 'Whitelisted' },
  { value: 'staff', label: 'Staff' },
  { value: 'admin', label: 'Admins' }
];

const IDENTITY_KEYS = ['prefix_keyword', 'bot_presence_activity', 'bot_presence_text'];
const AUDIENCE_KEYS = ['whitelist_role_ids', 'staff_role_ids', 'admin_role_ids'];
const BOT_CONFIG_KEYS = [...IDENTITY_KEYS, ...AUDIENCE_KEYS];

// HANDCRAFTED +field DESCRIPTORS - THE METADATA MARKS THESE computed (SO THE
// dfSettings FULL-FORM SAVE CANNOT WIPE THEM), WHICH WOULD RENDER READONLY
// THROUGH getFormData; THE BOT TAB IS THEIR ONE EDIT SURFACE
function configFieldDescriptors(core, config, keys) {
  const meta = core.models.configuration.metadata.fields;
  return keys.map(key => ({
    key,
    type: meta[key].type,
    label: meta[key].label,
    description: meta[key].description,
    options: meta[key].options,
    size: meta[key].size,
    value: config[key]
  }));
}

// ONE MATRIX ROW - THE DESCRIPTOR PLUS ITS EFFECTIVE RULE AT THIS SCOPE
async function featureRowView(core, feature, scope, servedTypes) {
  const effective = await features.effectiveRule(core, feature.id, scope || null);
  return {
    feature,
    slug: feature.id.replace(/[^a-zA-Z0-9]+/g, '-'),
    served: feature.providers.includes('discoflix') || feature.providers.some(type => servedTypes.has(type)),
    effective,
    // SCOPED: A SERVER ROW EXISTS; GLOBAL: A GLOBAL ROW EXISTS (VS DEFAULTS)
    hasOverride: scope ? effective.source === 'server' : effective.source === 'global'
  };
}

async function servedTypesOf(core) {
  const rows = await core.models.app.getMany({ enabled: true });
  return new Set(rows.filter(row => core.apps.isConfigured(row)).map(row => row.app_type));
}

// ── THE AI ROUTING BOARD ──────────────────────────────────────────────────
// EVERY AI PROVIDER'S DOOR ROWS IN ONE GROUP, ORGANIZED BY DOOR INSTEAD OF
// BY PROVIDER - N PROVIDER GROUPS EACH REPEATING THE SAME THREE ROW LABELS
// WERE ILLEGIBLE. EVERY (PROVIDER, DOOR) RULE STAYS ITS OWN ROW; ONLY THE
// PRESENTATION POOLS THEM, RANKED IN resolveAiDoor'S WALK ORDER.

// WHO ANSWERS THIS DOOR, PER AUDIENCE TIER - THE SAME WALK resolveAiDoor
// RUNS (SERVING PROVIDERS IN PRIORITY ORDER, FIRST ENABLED ROW WHOSE
// AUDIENCE ADMITS THE TIER). EXTRA ROLE GRANTS CAN WIDEN A ROW BEYOND ITS
// TIER, SO THE RIBBON IS THE BY-TIER PICTURE, NOT EVERY EDGE CASE.
// CONSECUTIVE TIERS WITH THE SAME WINNER COLLAPSE INTO ONE SEGMENT.
function aiRibbonOf(rows) {
  const winners = AUDIENCE_OPTIONS.map(tier => {
    const row = rows.find(r =>
      r.provider.served
      && r.effective.enabled
      && features.TIER_RANK[tier.value] >= features.TIER_RANK[r.effective.audience]
    );
    return row ? row.provider : null;
  });
  const segments = [];
  for (let i = 0; i < winners.length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.provider === winners[i]) {
      last.end = i;
    } else {
      segments.push({ provider: winners[i], start: i, end: i });
    }
  }
  const lastTier = AUDIENCE_OPTIONS.length - 1;
  return segments.map(seg => ({
    provider: seg.provider,
    label: seg.start === 0 && seg.end === lastTier ? 'Everyone'
      : seg.start === seg.end ? AUDIENCE_OPTIONS[seg.start].label
      : seg.end === lastTier ? `${AUDIENCE_OPTIONS[seg.start].label}+`
      : `${AUDIENCE_OPTIONS[seg.start].label}–${AUDIENCE_OPTIONS[seg.end].label}`
  }));
}

async function aiBoardOf(core, scope, servedTypes, installedTypes) {
  const aiFeatures = features.featureCatalog().filter(feature =>
    feature.ai && installedTypes.has(feature.ai.provider)
  );
  if (!aiFeatures.length) return null;

  // PRIORITY = resolveAiDoor'S WALK: SERVING INSTANCES DEFAULT-FIRST,
  // DEDUPED TO TYPES (RULES ARE PER TYPE); INSTALLED-BUT-UNSERVED TYPES
  // TRAIL UNRANKED - THEY CAN'T ANSWER UNTIL CONFIGURED + ENABLED
  const order = [];
  for (const instance of await core.ai.servingAiInstances()) {
    if (!order.includes(instance.app_type)) order.push(instance.app_type);
  }
  for (const feature of aiFeatures) {
    if (!order.includes(feature.ai.provider)) order.push(feature.ai.provider);
  }
  const providers = order.map((type, index) => {
    const manifest = core.apps.getType(type);
    const served = servedTypes.has(type);
    return { type, icon: manifest?.icon, label: manifest?.label || type, served, priority: served ? index + 1 : null };
  });

  const doors = [];
  for (const doorDef of AI_DOORS) {
    // DMS HAPPEN OUTSIDE ANY SERVER - RUNTIME ALWAYS RESOLVES THE GLOBAL
    // RULE, SO A SCOPED VIEW SHOWS THE GLOBAL ROWS READ-ONLY INSTEAD OF
    // OFFERING AN OVERRIDE THE BOT WOULD NEVER READ
    const globalOnly = !!scope && doorDef.door === 'dms';
    const rows = [];
    for (const provider of providers) {
      const feature = features.getFeature(`${provider.type}.ai-${doorDef.door}`);
      if (!feature) continue;
      const row = await featureRowView(core, feature, globalOnly ? '' : scope, servedTypes);
      row.provider = provider;
      row.globalOnly = globalOnly;
      rows.push(row);
    }
    doors.push({ ...doorDef, globalOnly, rows, ribbon: aiRibbonOf(rows) });
  }

  // PERSONALIZED REPLIES - A FOURTH, RIBBONLESS CARD: NO ROUTING RACE TO
  // VISUALIZE, JUST WHOSE DOSSIER EACH PROVIDER MAY READ
  const dossierRows = [];
  for (const provider of providers) {
    const feature = features.getFeature(`${provider.type}.ai-dossier`);
    if (!feature) continue;
    const row = await featureRowView(core, feature, scope, servedTypes);
    row.provider = provider;
    dossierRows.push(row);
  }
  if (dossierRows.length) {
    doors.push({
      door: 'dossier',
      label: 'Personalized replies',
      description: "Whose dossier - operator notes and recent requests - each provider may read to weight its replies. Off until you switch it on.",
      ribbon: null,
      rows: dossierRows
    });
  }

  return { ai: true, key: 'ai', label: 'AI Assistant', providers, doors };
}

async function buildBotMatrix(core, scope = '') {
  const [config, servers, servedTypes, appRows] = await Promise.all([
    core.models.configuration.get(),
    core.models.discordServer.getMany({ available: true }, {}, [{ sort_position: 'asc' }]),
    servedTypesOf(core),
    core.models.app.getMany({})
  ]);
  const wantScope = servers.some(server => server.server_id === scope) ? scope : '';
  const installedTypes = new Set(appRows.map(row => row.app_type));

  // GROUP FEATURES BY PROVIDER SET (FIRST-APPEARANCE ORDER), DISCOFLIX LAST -
  // APP-PROVIDED FEATURES READ AS "WHAT THIS APP GIVES THE BOT"
  const groups = new Map();
  for (const feature of features.featureCatalog()) {
    // AI DOOR ROWS RENDER ON THE ROUTING BOARD, NOT AS PER-PROVIDER GROUPS
    if (feature.ai) continue;
    // requiresInstall ROWS ONLY SURFACE ONCE THEIR APP EXISTS - RULES FOR
    // APPS YOU NEVER ADDED ARE NOISE, NOT DISCOVERY
    if (feature.requiresInstall && !feature.providers.some(type => installedTypes.has(type))) continue;
    const key = [...feature.providers].sort().join('+');
    if (!groups.has(key)) {
      const manifests = feature.providers.map(type => core.apps.getType(type)).filter(Boolean);
      groups.set(key, {
        key,
        label: manifests.map(manifest => manifest.label).join(' • ') || key,
        providers: manifests.map(manifest => ({ icon: manifest.icon, label: manifest.label })),
        features: []
      });
    }
    groups.get(key).features.push(await featureRowView(core, feature, wantScope, servedTypes));
  }
  const ordered = [...groups.values()].sort((a, b) =>
    (a.key === 'discoflix' ? 1 : 0) - (b.key === 'discoflix' ? 1 : 0)
  );

  // THE AI BOARD SITS WHERE THE PER-PROVIDER GROUPS USED TO: AFTER THE APP
  // GROUPS, BEFORE THE DISCOFLIX CORE GROUP
  const aiBoard = await aiBoardOf(core, wantScope, servedTypes, installedTypes);
  if (aiBoard) {
    const dfIndex = ordered.findIndex(group => group.key === 'discoflix');
    ordered.splice(dfIndex === -1 ? ordered.length : dfIndex, 0, aiBoard);
  }

  return {
    scope: wantScope,
    scopeName: servers.find(server => server.server_id === wantScope)?.server_name || null,
    servers: servers.map(server => ({ id: server.server_id, name: server.server_name })),
    audienceOptions: AUDIENCE_OPTIONS,
    identityFields: configFieldDescriptors(core, config, IDENTITY_KEYS),
    audienceFields: configFieldDescriptors(core, config, AUDIENCE_KEYS),
    groups: ordered
  };
}

// ── ROUTE HANDLERS (DISCOFLIX-GUARDED) ───────────────────────────────────

async function selfInstanceOf(ctx) {
  const instance = await ctx.core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return null;
  }
  return instance;
}

// SCOPE SWAP - RE-RENDERS #dfBotMatrix FOR THE PICKED SERVER (OR GLOBAL)
async function appBotMatrix(ctx) {
  const instance = await selfInstanceOf(ctx);
  if (!instance) return;
  return ctx.compileView(['apps/sections/dfBotMatrix.pug'], {
    activeApp: instance,
    bot: await buildBotMatrix(ctx.core, String(ctx.query.scope || ''))
  });
}

// BOT IDENTITY + AUDIENCES - PARTIAL update() ONLY. safeUpdateOne WOULD RUN
// FULL-FORM SEMANTICS AND RESET EVERY EDITABLE FIELD ABSENT FROM THIS FORM.
async function saveBotConfig(ctx) {
  const core = ctx.core;
  const instance = await selfInstanceOf(ctx);
  if (!instance) return;

  const body = ctx.request.body || {};
  const data = {};
  for (const key of BOT_CONFIG_KEYS) {
    if (key in body) data[key] = String(body[key] ?? '');
  }
  try {
    await core.models.configuration.update(data);
    if (core.client?.isReady()) core.discord.applyPresence().catch(() => {});
  } catch (err) {
    core.logger.error('BOT CONFIG SAVE FAILED:', err);
    ctx.status = 400;
    ctx.body = { error: err.message };
    return;
  }
  return ctx.compileView(['extra/notification.pug'], { message: 'Bot settings saved' });
}

// COERCE A ROW FORM INTO A RULE WRITE - EXTENTS VALIDATED BY DESCRIPTOR
function ruleDataFrom(feature, body) {
  const audience = AUDIENCE_OPTIONS.some(option => option.value === body.audience)
    ? body.audience
    : 'everyone';
  const extents = {};
  for (const extent of feature.extents || []) {
    const raw = body[`extent_${extent.key}`];
    if (extent.type === 'toggle') {
      // UNCHECKED CHECKBOXES DON'T POST - ABSENT MEANS OFF. SPARSE STORAGE:
      // ONLY A VALUE THAT DIFFERS FROM THE DESCRIPTOR DEFAULT IS KEPT
      const on = ['true', 'on', '1'].includes(String(raw ?? '').toLowerCase());
      if (on !== !!Number(extent.default)) extents[extent.key] = on ? 1 : 0;
      continue;
    }
    if (raw === undefined || raw === '') continue;
    let value = Number(raw);
    if (isNaN(value)) continue;
    if (extent.min !== undefined) value = Math.max(extent.min, value);
    if (extent.max !== undefined) value = Math.min(extent.max, value);
    extents[extent.key] = value;
  }
  return {
    // UNCHECKED CHECKBOXES DON'T POST - ROW FORMS ALWAYS SEND THE FULL SET
    enabled: ['true', 'on', '1'].includes(String(body.enabled).toLowerCase()),
    audience,
    role_ids: String(body.role_ids || ''),
    extents_json: Object.keys(extents).length ? JSON.stringify(extents) : null
  };
}

async function respondWithFeatureRow(ctx, instance, feature, scope, message) {
  const bot = await buildBotMatrix(ctx.core, scope);

  // AI DOOR ROWS COME BACK FROM THE FRESH BOARD (PROVIDER CHIP + PRIORITY
  // INTACT) WITH THE DOOR'S WHO-ANSWERS RIBBON RIDING ALONG OOB - AN EDIT
  // THAT REROUTES A DOOR UPDATES THE ANSWER STRIP IN THE SAME SWAP
  if (feature.ai) {
    const board = bot.groups.find(group => group.ai);
    const door = board?.doors.find(entry => entry.door === feature.ai.door);
    const row = door?.rows.find(entry => entry.feature.id === feature.id);
    if (row) {
      // RIBBONLESS CARDS (PERSONALIZED REPLIES) SWAP THE ROW ALONE
      const views = ['apps/sections/dfBotFeatureRow.pug'];
      const locals = [{ row }];
      if (door.ribbon) {
        views.push('apps/sections/dfBotAiRibbon.pug');
        locals.push({ door, oob: true });
      }
      views.push('extra/notification.pug');
      locals.push({});
      return ctx.compileView(views, { activeApp: instance, bot, message }, locals);
    }
  }

  return ctx.compileView(['apps/sections/dfBotFeatureRow.pug', 'extra/notification.pug'], {
    activeApp: instance,
    bot,
    row: await featureRowView(ctx.core, feature, bot.scope, await servedTypesOf(ctx.core)),
    message
  });
}

// UPSERT ONE RULE FOR THE POSTED SCOPE. clone=1 COPIES THE CURRENT EFFECTIVE
// VALUES INTO A NEW PER-SERVER OVERRIDE ROW ("Override for this server").
async function saveBotFeature(ctx) {
  const core = ctx.core;
  const instance = await selfInstanceOf(ctx);
  if (!instance) return;

  const feature = features.getFeature(ctx.params.featureId);
  if (!feature) {
    ctx.status = 404;
    return;
  }
  const body = ctx.request.body || {};
  const scope = String(body.scope || '');

  try {
    let data;
    if (body.clone) {
      const effective = await features.effectiveRule(core, feature.id, null);
      data = {
        enabled: effective.enabled,
        audience: effective.audience,
        role_ids: effective.role_ids,
        extents_json: Object.keys(effective.extents).length ? JSON.stringify(effective.extents) : null
      };
    } else {
      data = ruleDataFrom(feature, body);
    }
    await core.models.botFeatureRule.upsertRule(feature.id, scope || null, data);
    features.invalidateRules();
  } catch (err) {
    core.logger.error('BOT FEATURE SAVE FAILED:', err);
    ctx.status = 400;
    ctx.body = { error: err.message };
    return;
  }
  const message = body.clone ? `Overriding "${feature.label}" for this server` : `Saved "${feature.label}"`;
  return respondWithFeatureRow(ctx, instance, feature, scope, message);
}

// DELETE THE SCOPED ROW - A SERVER FALLS BACK TO GLOBAL, GLOBAL TO DEFAULTS
async function resetBotFeature(ctx) {
  const core = ctx.core;
  const instance = await selfInstanceOf(ctx);
  if (!instance) return;

  const feature = features.getFeature(ctx.params.featureId);
  if (!feature) {
    ctx.status = 404;
    return;
  }
  const scope = String(ctx.query.scope || '');
  await core.models.botFeatureRule.deleteRule(feature.id, scope || null);
  features.invalidateRules();
  const message = scope ? `"${feature.label}" follows the global rule again` : `"${feature.label}" reset to defaults`;
  return respondWithFeatureRow(ctx, instance, feature, scope, message);
}

module.exports = {
  buildBotMatrix,
  servedTypesOf,
  appBotMatrix,
  saveBotConfig,
  saveBotFeature,
  resetBotFeature
};
