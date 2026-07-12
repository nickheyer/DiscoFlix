const DAY_MS = 24 * 60 * 60 * 1000;

// PER-USER OVERRIDES WIN WHEN SET (> 0), OTHERWISE THE GLOBAL CONFIG VALUE.
// EVERYWHERE IN THESE LIMITS, 0 MEANS UNLIMITED.
function resolveLimit(userValue, configValue) {
  return userValue > 0 ? userValue : configValue;
}

function isAdmin(dbUser) {
  return dbUser.is_superuser || dbUser.is_staff;
}

// GATE CHECKS THAT RUN BEFORE ANY ARR TRAFFIC. RETURNS null WHEN ALLOWED,
// OTHERWISE A USER-PRESENTABLE DENIAL MESSAGE.
async function checkRequestAllowance(core, dbUser) {
  if (!dbUser.is_active) {
    return 'Your account has been deactivated - you cannot make requests.';
  }
  if (isAdmin(dbUser)) return null;

  const dailyLimit = dbUser.max_requests_in_day;
  if (dailyLimit > 0) {
    const since = new Date(Date.now() - DAY_MS);
    const recentCount = await core.prisma.mediaRequest.count({
      where: {
        created_at: { gte: since },
        users: { some: { id: dbUser.id } }
      }
    });
    if (recentCount >= dailyLimit) {
      return `You've hit your limit of ${dailyLimit} request${dailyLimit === 1 ? '' : 's'} per day - try again later.`;
    }
  }
  return null;
}

// null WHEN ALLOWED, OTHERWISE A DENIAL MESSAGE
function checkSeasonLimit(config, dbUser, seasonCount) {
  if (isAdmin(dbUser)) return null;
  const limit = resolveLimit(dbUser.max_seasons_for_non_admin, config.max_seasons_for_non_admin);
  if (limit > 0 && seasonCount > limit) {
    return `That show has ${seasonCount} seasons - you can only request shows with up to ${limit}.`;
  }
  return null;
}

function effectiveMaxResults(config, dbUser) {
  return resolveLimit(dbUser.max_results, config.max_results);
}

module.exports = {
  checkRequestAllowance,
  checkSeasonLimit,
  effectiveMaxResults,
  isAdmin
};
