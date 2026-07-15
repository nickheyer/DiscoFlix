// THE RICH USER PROFILE MODAL - EVERY USER CLICK (CHAT AVATAR/AUTHOR NAME,
// MEMBER ROW, USER CARD (i), REQUESTER CHIP, ORIGIN ROW) LANDS HERE. THE
// GENERIC /settings POPUP KEEPS SERVING OTHER MODEL TYPES.
const features = require('../../core/bot/interactions/features');
const { parseRoleList, memberRoleTokens } = require('../../core/bot/interactions/access');
const { rootRelative, lastSeenLabel } = require('./apps');
const { servedTypesOf } = require('./botMatrix');

const TIER_ORDER = ['everyone', 'whitelisted', 'staff', 'admin'];
const TIER_LABELS = { everyone: 'Everyone', whitelisted: 'Whitelisted', staff: 'Staff', admin: 'Admin' };

// CUMULATIVE FLAG MAP - LOWER FLAGS RIDE ALONG SO userTier'S HIGHEST-FLAG
// READ STAYS EXACT AND A USERS-CARD CHECKBOX DEMOTE DEGRADES ONE STEP AT A TIME
const TIER_FLAGS = {
  everyone: { is_superuser: false, is_staff: false, is_whitelisted: false },
  whitelisted: { is_superuser: false, is_staff: false, is_whitelisted: true },
  staff: { is_superuser: false, is_staff: true, is_whitelisted: true },
  admin: { is_superuser: true, is_staff: true, is_whitelisted: true }
};

// THE PROFILE FORM'S WHOLE SURFACE - POSTS FULL-FORM ON change, SO ABSENT
// CHECKBOXES READ AS UNCHECKED. NEVER safeUpdateOne HERE: ITS FULL-FORM
// RESET WOULD ZERO THE TIER FLAGS THE LADDER OWNS.
const PROFILE_FORM_FIELDS = ['is_active', 'max_requests_in_day', 'max_results', 'max_seasons_for_non_admin', 'notes'];
const PROFILE_REQUEST_ROWS = 10;

function tierKeyOf(user) {
  return TIER_ORDER[features.userTier(user)];
}

// WHICH CONFIGURED ROLE MAPPINGS THE USER ACTUALLY HOLDS, FROM THE LIVE
// GUILD MEMBER CACHES - ONLY ANSWERABLE WHILE THE BOT IS ONLINE. A HELD
// MAPPING MEANS A CONSOLE DEMOTE BELOW THAT TIER RE-GRANTS ON NEXT SIGHTING.
function roleGrantSources(core, config, user) {
  const result = { checked: false, grants: [], highestRank: -1 };
  const client = core.client;
  if (!client || !client.isReady()) return result;
  result.checked = true;

  const mappings = [
    { tier: 'admin', configValue: config.admin_role_ids },
    { tier: 'staff', configValue: config.staff_role_ids },
    { tier: 'whitelisted', configValue: config.whitelist_role_ids }
  ];
  for (const server of user.discord_servers || []) {
    const guild = client.guilds.cache.get(server.server_id);
    const member = guild?.members?.cache?.get(user.id);
    if (!member) continue;
    for (const { tier, configValue } of mappings) {
      const wanted = parseRoleList(configValue);
      if (!wanted.length) continue;
      const held = member.roles.cache.find(role =>
        wanted.includes(String(role.id)) || wanted.includes(String(role.name || '').toLowerCase())
      );
      if (held) {
        result.grants.push({ tier, tierLabel: TIER_LABELS[tier], roleName: held.name, guildName: guild.name });
        result.highestRank = Math.max(result.highestRank, features.TIER_RANK[tier]);
      }
    }
  }
  return result;
}

// SHORT EXTENT COPY FOR AN ALLOWED ROW - "Max results: unlimited · Daily
// cap: 5 (override)"; 0 READS unlimited TO MATCH THE GATE'S SEMANTICS
function describeExtents(feature, gate, user) {
  const parts = [];
  for (const extent of feature.extents || []) {
    if (!(extent.key in gate.extents)) continue;
    const value = Number(gate.extents[extent.key]);
    const overridden = extent.userOverride && Number(user[extent.userOverride]) > 0
      && value === Number(user[extent.userOverride]);
    parts.push(`${extent.label}: ${value === 0 ? 'unlimited' : value}${overridden ? ' (override)' : ''}`);
  }
  return parts.join(' · ') || null;
}

// WHAT THIS USER CAN DO, PER SERVED FEATURE, THROUGH THE REAL RESOLVER.
// scope '' = GLOBAL RULES WITH NO ROLE TOKENS (HONEST DEFAULT); A SERVER
// SCOPE USES LIVE ROLE TOKENS WHEN THE MEMBER IS CACHED, ELSE TIER-ONLY
// WITH A "+roles" MARKER ON ROWS EXTRA ROLES COULD WIDEN.
async function buildAccessSummary(core, user, scope) {
  const servedTypes = await servedTypesOf(core);
  let roleTokens = [];
  let liveRoles = false;
  if (scope && core.client?.isReady()) {
    const member = core.client.guilds.cache.get(scope)?.members?.cache?.get(user.id);
    if (member) {
      roleTokens = memberRoleTokens(member);
      liveRoles = true;
    }
  }

  const rows = [];
  for (const feature of features.featureCatalog()) {
    const served = feature.providers.includes('discoflix')
      || feature.providers.some(type => servedTypes.has(type));
    if (!served) continue;
    const gate = await features.resolveFeature(core, feature.id, {
      dbUser: user,
      roleTokens,
      guildId: scope || null
    });
    const effective = await features.effectiveRule(core, feature.id, scope || null);
    const reasons = { disabled: 'off here', audience: `needs ${effective.audience}`, inactive: 'deactivated' };
    rows.push({
      id: feature.id,
      label: feature.label,
      group: feature.group || 'general',
      allowed: gate.allowed,
      reason: gate.allowed ? null : (reasons[gate.reason] || gate.reason),
      // A DENIED ROW EXTRA DISCORD ROLES COULD STILL OPEN - ONLY FLAGGED
      // WHEN WE COULDN'T CHECK THE REAL ROLES
      rolesMayWiden: !gate.allowed && !liveRoles && !!String(effective.role_ids || '').trim(),
      extents: gate.allowed ? describeExtents(feature, gate, user) : null
    });
  }
  return { rows, liveRoles };
}

async function buildUserProfile(core, user, scope = '') {
  const config = await core.models.configuration.get();
  const tier = tierKeyOf(user);
  const tierRank = features.TIER_RANK[tier];
  const roleGrants = roleGrantSources(core, config, user);
  const roleMappingsConfigured = [config.admin_role_ids, config.staff_role_ids, config.whitelist_role_ids]
    .some(value => String(value || '').trim());

  const requests = await core.models.mediaRequest.getUserRequests(user.id, { users: true, app: true });
  const wantScope = (user.discord_servers || []).some(server => server.server_id === scope) ? scope : '';

  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    accentColor: user.accent_color && user.accent_color.toLowerCase() !== 'ffffff'
      ? `#${String(user.accent_color).replace('#', '')}`
      : null,
    avatarUrl: rootRelative(user.avatar_url),
    isBot: !!user.is_bot,
    isClient: !!user.is_client,
    isActive: !!user.is_active,
    wantsAccess: !!user.access_requested_at
      && !user.is_whitelisted && !user.is_superuser && !user.is_staff,
    lastSeenLabel: lastSeenLabel(user.last_seen_at),
    flags: {
      is_superuser: user.is_superuser,
      is_staff: user.is_staff,
      is_whitelisted: user.is_whitelisted
    },
    tier,
    ladder: TIER_ORDER.map(key => ({
      key,
      label: TIER_LABELS[key],
      rank: features.TIER_RANK[key],
      active: key === tier,
      attained: features.TIER_RANK[key] < tierRank
    })),
    roleGrants,
    // DEMOTION BELOW A HELD MAPPING'S TIER RE-GRANTS ON NEXT SIGHTING - SAY SO
    warnRegrant: roleGrants.grants.length > 0,
    roleMappingsConfigured,
    fields: core.models.user.getFormData(user),
    formFields: PROFILE_FORM_FIELDS,
    scope: wantScope,
    scopeOptions: [
      { value: '', label: 'Global rules' },
      ...(user.discord_servers || []).map(server => ({ value: server.server_id, label: server.server_name }))
    ],
    access: (user.is_bot || user.is_client) ? { rows: [], liveRoles: false } : await buildAccessSummary(core, user, wantScope),
    requests: {
      total: requests.length,
      rows: requests.slice(0, PROFILE_REQUEST_ROWS).map(request => core.apps.buildRequestView(request))
    }
  };
}

async function loadUser(core, id) {
  return core.models.user.findFirst({ id }, { discord_servers: true });
}

async function getUserProfile(ctx) {
  const user = await loadUser(ctx.core, ctx.params.id);
  if (!user) {
    ctx.status = 404;
    return;
  }
  const profile = await buildUserProfile(ctx.core, user);
  return ctx.compileView('modals/user/profile.pug', { profile });
}

// THE ACCESS SCOPE SELECT RE-RENDERS ONLY ITS OWN SECTION
async function getUserProfileAccess(ctx) {
  const user = await loadUser(ctx.core, ctx.params.id);
  if (!user) {
    ctx.status = 404;
    return;
  }
  const profile = await buildUserProfile(ctx.core, user, String(ctx.query.scope || '').trim());
  return ctx.compileView('modals/user/_access.pug', { profile });
}

async function saveUserProfile(ctx) {
  const core = ctx.core;
  const user = await loadUser(core, ctx.params.id);
  if (!user) {
    ctx.status = 404;
    return;
  }

  const body = ctx.request.body || {};
  // PARTIAL update() WITH AN EXPLICIT WHITELIST - THE FORM DOESN'T CARRY THE
  // TIER FLAGS, AND safeUpdateOne WOULD RESET THEM AS "ABSENT"
  const data = {
    is_active: ['true', 'on', '1'].includes(String(body.is_active).toLowerCase()),
    notes: String(body.notes || '').trim(),
    max_results: Math.max(0, parseInt(body.max_results, 10) || 0),
    max_seasons_for_non_admin: Math.max(0, parseInt(body.max_seasons_for_non_admin, 10) || 0),
    max_requests_in_day: Math.max(0, parseInt(body.max_requests_in_day, 10) || 0)
  };
  await core.models.user.update({ id: user.id }, data);

  const fresh = await loadUser(core, user.id);
  const profile = await buildUserProfile(core, fresh);
  return ctx.compileView(['modals/user/_profileBody.pug', 'extra/notification.pug'], {
    profile,
    message: `Saved ${fresh.display_name || fresh.username}`
  });
}

async function setUserTier(ctx) {
  const core = ctx.core;
  const user = await loadUser(core, ctx.params.id);
  if (!user) {
    ctx.status = 404;
    return;
  }

  const value = String(ctx.request.body?.value || '');
  if (!TIER_FLAGS[value]) {
    ctx.status = 400;
    return;
  }

  const before = features.userTier(user);
  const data = { ...TIER_FLAGS[value] };
  // ANY GRANT SETTLES A PENDING ACCESS ASK (SAME RULE AS THE USERS CARD)
  if (user.access_requested_at && features.TIER_RANK[value] >= features.TIER_RANK.whitelisted) {
    data.access_requested_at = null;
  }
  await core.models.user.update({ id: user.id }, data);

  const fresh = await loadUser(core, user.id);
  const profile = await buildUserProfile(core, fresh);
  const name = fresh.display_name || fresh.username;
  const after = features.TIER_RANK[value];
  const message = after === before
    ? `${name} is already ${TIER_LABELS[value]}`
    : `${after > before ? 'Promoted' : 'Demoted'} ${name} to ${TIER_LABELS[value]}`;
  return ctx.compileView(['modals/user/_profileBody.pug', 'extra/notification.pug'], { profile, message });
}

module.exports = {
  buildUserProfile,
  getUserProfile,
  getUserProfileAccess,
  saveUserProfile,
  setUserTier
};
