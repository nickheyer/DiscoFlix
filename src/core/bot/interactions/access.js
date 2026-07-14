// REQUEST ACCESS CONTROL - THE WHITELIST GATE AND GUILD-ROLE PERMISSION
// GRANTS. ROLE LISTS ARE COMMA-SEPARATED ROLE NAMES OR IDS, CASE-INSENSITIVE.

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

// null = ALLOWED, OTHERWISE A USER-PRESENTABLE DENIAL. ADMINS AND STAFF
// ALWAYS PASS; IN WHITELIST MODE EVERYONE ELSE NEEDS THE FLAG OR A LISTED ROLE
function checkWhitelist(config, dbUser, roleTokens) {
  if (config.request_access !== 'whitelist') return null;
  if (dbUser.is_superuser || dbUser.is_staff || dbUser.is_whitelisted) return null;
  if (rolesMatch(config.whitelist_role_ids, roleTokens)) return null;
  return 'Requests are limited to approved members here - ask an admin to whitelist you.';
}

module.exports = {
  parseRoleList,
  memberRoleTokens,
  rolesMatch,
  roleGrantsFor,
  checkWhitelist
};
