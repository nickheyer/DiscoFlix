const { rolesMatch } = require('./access');

// FEATURE RESOLUTION - THE RBAC LAYER BETWEEN THE INTERACTION REGISTRY, THE
// REQUEST FLOW, AND THE CONSOLE'S DISCORD BOT TAB. EVERY BOT FEATURE CARRIES
// A DESCRIPTOR ({ id, label, description, group, defaultEnabled,
// defaultAudience, accessAskOnDeny?, extents: [{ key, label, type, min, max,
// default, userOverride?, adminExempt? }] }); BotFeatureRule ROWS OVERRIDE
// THE DEFAULTS GLOBALLY OR PER SERVER (A SERVER ROW IS A FULL CLONE THAT
// WINS OUTRIGHT; DMs ALWAYS RESOLVE THE GLOBAL RULE).

const TIER_RANK = { everyone: 0, whitelisted: 1, staff: 2, admin: 3 };
const RULE_TTL_MS = 30 * 1000;

// FEATURES WITH NO INTERACTION DEF OF THEIR OWN - RESOLVED WHERE THEY APPLY
// (THE MONITOR CHECKS dm-notifications PER REQUESTER AT COMPLETION TIME)
const CORE_FEATURES = [
  {
    id: 'dm-notifications',
    label: 'Completion DMs',
    description: 'Also DM requesters when their download finishes importing',
    group: 'notifications',
    providers: ['discoflix'],
    defaultEnabled: false,
    defaultAudience: 'everyone',
    extents: []
  }
];

// LAZY-BUILT AND CACHED LIKE allDefs - index/request REQUIRE THIS MODULE AT
// LOAD TIME, SO THEIR REQUIRES STAY INSIDE THE FUNCTION (CYCLE-SAFE)
let _catalog = null;
function featureCatalog() {
  if (!_catalog) {
    const { allDefs } = require('./index');
    const { REQUEST_CAPABILITIES } = require('./request');
    const fromDefs = allDefs()
      .filter(def => def.feature)
      .map(def => ({ providers: def.appTypes || ['discoflix'], ...def.feature }));
    _catalog = [...fromDefs, ...REQUEST_CAPABILITIES, ...CORE_FEATURES];
  }
  return _catalog;
}

function getFeature(featureId) {
  return featureCatalog().find(feature => feature.id === featureId) || null;
}

// ONE findMany OVER THE (TINY) RULE TABLE, CACHED WITH A SHORT TTL - THE
// CONSOLE'S SAVE ROUTES CALL invalidateRules() SO SAME-PROCESS EDITS APPLY
// IMMEDIATELY; THE TTL ONLY COVERS OUT-OF-BAND WRITES
let _rules = null;
let _rulesFetchedAt = 0;

async function loadRules(core) {
  if (_rules && Date.now() - _rulesFetchedAt < RULE_TTL_MS) return _rules;
  const rows = await core.models.botFeatureRule.allRules();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.feature_id)) map.set(row.feature_id, { global: null, byServer: new Map() });
    const entry = map.get(row.feature_id);
    if (row.server_id) entry.byServer.set(row.server_id, row);
    else entry.global = row;
  }
  _rules = map;
  _rulesFetchedAt = Date.now();
  return map;
}

function invalidateRules() {
  _rules = null;
  _rulesFetchedAt = 0;
}

function defaultExtentsOf(descriptor) {
  const extents = {};
  for (const extent of descriptor?.extents || []) {
    extents[extent.key] = extent.default ?? 0;
  }
  return extents;
}

// EFFECTIVE RULE FOR A SCOPE: SERVER ROW ?? GLOBAL ROW ?? DESCRIPTOR
// DEFAULTS. ROW EXTENTS ARE SPARSE - ABSENT KEYS FALL THROUGH TO DEFAULTS.
async function effectiveRule(core, featureId, guildId = null) {
  const descriptor = getFeature(featureId);
  const defaults = {
    enabled: descriptor ? descriptor.defaultEnabled !== false : true,
    audience: descriptor?.defaultAudience || 'everyone',
    role_ids: '',
    extents: defaultExtentsOf(descriptor),
    source: 'default'
  };
  const rules = await loadRules(core);
  const entry = rules.get(featureId);
  const row = (guildId && entry?.byServer.get(guildId)) || entry?.global || null;
  if (!row) return defaults;

  let sparse = {};
  try { sparse = row.extents_json ? JSON.parse(row.extents_json) : {}; } catch (err) { sparse = {}; }
  return {
    enabled: !!row.enabled,
    audience: TIER_RANK[row.audience] !== undefined ? row.audience : defaults.audience,
    role_ids: row.role_ids || '',
    extents: { ...defaults.extents, ...sparse },
    source: row.server_id ? 'server' : 'global'
  };
}

// TIER FROM THE PERSISTED FLAGS - buildInvocation ALREADY RAN GRANT-ONLY
// ROLE PROMOTION, SO LIVE ROLE HOLDERS CARRY THEIR FLAG BY GATE TIME
function userTier(dbUser) {
  if (!dbUser) return TIER_RANK.everyone;
  if (dbUser.is_superuser) return TIER_RANK.admin;
  if (dbUser.is_staff) return TIER_RANK.staff;
  if (dbUser.is_whitelisted) return TIER_RANK.whitelisted;
  return TIER_RANK.everyone;
}

// THE ANSWER EVERY GATE ASKS FOR. UNKNOWN IDS FAIL OPEN (WITH A WARN) -
// FAILING CLOSED ON A TYPO'D ID WOULD BRICK A FEATURE WITH NO MATRIX ROW TO
// RESCUE IT. EXTENT PRECEDENCE: RULE VALUE -> PER-USER OVERRIDE COLUMN
// (>0 WINS) -> ADMIN EXEMPTION (staff+ GO UNLIMITED WHERE DECLARED).
// EVERYWHERE IN EXTENTS, 0 MEANS UNLIMITED.
async function resolveFeature(core, featureId, { dbUser = null, roleTokens = [], guildId = null } = {}) {
  const descriptor = getFeature(featureId);
  if (!descriptor) {
    core.logger.warn(`resolveFeature: unknown feature id '${featureId}' - allowing`);
    return { allowed: true, extents: {} };
  }
  if (dbUser && !dbUser.is_active) {
    return {
      allowed: false,
      reason: 'inactive',
      denialMessage: 'Your account has been deactivated - you cannot use this.',
      extents: {}
    };
  }
  const rule = await effectiveRule(core, featureId, guildId);
  if (!rule.enabled) {
    return {
      allowed: false,
      reason: 'disabled',
      denialMessage: 'That feature is switched off here.',
      extents: {}
    };
  }
  const tier = userTier(dbUser);
  if (tier < TIER_RANK[rule.audience] && !rolesMatch(rule.role_ids, roleTokens)) {
    return {
      allowed: false,
      reason: 'audience',
      denialMessage: `You don't have access to "${descriptor.label}" here - ask an admin.`,
      extents: {}
    };
  }

  const extents = { ...rule.extents };
  for (const extent of descriptor.extents || []) {
    if (extent.userOverride && dbUser && Number(dbUser[extent.userOverride]) > 0) {
      extents[extent.key] = Number(dbUser[extent.userOverride]);
    }
    if (extent.adminExempt && tier >= TIER_RANK.staff) {
      extents[extent.key] = 0;
    }
  }
  return { allowed: true, extents };
}

// INVOCATION OBJECTS ALREADY CARRY dbUser/roleTokens/guildId - THE SHAPE
// EVERY IN-FLOW CAPABILITY CHECK USES
function resolveForCtx(ctx, featureId) {
  return resolveFeature(ctx.core, featureId, ctx);
}

module.exports = {
  TIER_RANK,
  CORE_FEATURES,
  featureCatalog,
  getFeature,
  loadRules,
  invalidateRules,
  effectiveRule,
  userTier,
  resolveFeature,
  resolveForCtx
};
