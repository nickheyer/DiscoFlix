const DAY_MS = 24 * 60 * 60 * 1000;

// THE GATES THEMSELVES LIVE IN features.js NOW (PER-FEATURE RULES + EXTENTS);
// ONLY THE SHARED PRIMITIVES REMAIN HERE.

function isAdmin(dbUser) {
  return dbUser.is_superuser || dbUser.is_staff;
}

// REQUESTS THIS USER MADE IN THE LAST 24h - THE DAILY-CAP EXTENT'S COUNTER
async function countRequestsSince(core, dbUser) {
  const since = new Date(Date.now() - DAY_MS);
  return core.prisma.mediaRequest.count({
    where: {
      created_at: { gte: since },
      users: { some: { id: dbUser.id } }
    }
  });
}

module.exports = {
  isAdmin,
  countRequestsSince
};
