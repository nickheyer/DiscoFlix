// GUILD-ROLE TOKEN HELPERS + GRANT-ONLY TIER PROMOTION. THE ACCESS GATES
// THEMSELVES LIVE IN features.js (PER-FEATURE AUDIENCE RULES). ROLE LISTS
// ARE COMMA-SEPARATED ROLE NAMES OR IDS, CASE-INSENSITIVE.

function parseRoleList(configValue) {
  return String(configValue || '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

// A DISCORD MEMBER'S ROLES AS MATCHABLE TOKENS (IDS + NAMES, LOWERCASED).
// WORKS FOR GUILD MESSAGES AND GUILD SLASH CALLS; DMS HAVE NO MEMBER = []
function memberRoleTokens(member) {
  const roles = member?.roles?.cache;
  if (!roles) return [];
  const tokens = [];
  for (const role of roles.values()) {
    tokens.push(String(role.id));
    tokens.push(String(role.name || '').toLowerCase());
  }
  return tokens;
}

function rolesMatch(configValue, roleTokens) {
  const wanted = parseRoleList(configValue);
  if (!wanted.length || !roleTokens.length) return false;
  const held = new Set(roleTokens);
  return wanted.some(token => held.has(token));
}

// GRANT-ONLY ROLE MAPPING: HOLDING A MAPPED ROLE PROMOTES, LOSING IT NEVER
// AUTO-DEMOTES - THE CONSOLE'S USERS SECTION STAYS THE PLACE TO REVOKE
function roleGrantsFor(config, roleTokens) {
  const grants = {};
  if (rolesMatch(config.admin_role_ids, roleTokens)) grants.is_superuser = true;
  if (rolesMatch(config.staff_role_ids, roleTokens)) grants.is_staff = true;
  if (rolesMatch(config.whitelist_role_ids, roleTokens)) grants.is_whitelisted = true;
  return grants;
}

module.exports = {
  parseRoleList,
  memberRoleTokens,
  rolesMatch,
  roleGrantsFor
};
