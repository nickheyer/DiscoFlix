// THE DISCORD BOT TAB - BOT IDENTITY + AUDIENCE MAPPING (THE SIX CONFIG
// FIELDS THAT MOVED OFF dfSettings) AND THE FEATURE MATRIX: EVERY FEATURE
// THE BOT OFFERS, GROUPED BY THE APP THAT PROVIDES IT, WITH PER-FEATURE
// AUDIENCE GRANTS AND EXTENTS, GLOBALLY OR PER DISCORD SERVER.
const features = require('../../core/bot/interactions/features');

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

async function buildBotMatrix(core, scope = '') {
  const [config, servers, servedTypes] = await Promise.all([
    core.models.configuration.get(),
    core.models.discordServer.getMany({ available: true }, {}, [{ sort_position: 'asc' }]),
    servedTypesOf(core)
  ]);
  const wantScope = servers.some(server => server.server_id === scope) ? scope : '';

  // GROUP FEATURES BY PROVIDER SET (FIRST-APPEARANCE ORDER), DISCOFLIX LAST -
  // APP-PROVIDED FEATURES READ AS "WHAT THIS APP GIVES THE BOT"
  const groups = new Map();
  for (const feature of features.featureCatalog()) {
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
  appBotMatrix,
  saveBotConfig,
  saveBotFeature,
  resetBotFeature
};
