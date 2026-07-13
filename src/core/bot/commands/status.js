const MAX_STATUS_ROWS = 10;

// ONE LINE PER OPEN REQUEST - LIVE QUEUE STATE RIDES THE HEARTBEAT'S CACHE
// SO STATUS NEVER BLOCKS ON SERVICE HTTP
function describeRequest(core, request) {
  const title = request.media?.title || request.orig_parsed_title || 'Unknown';
  let seasonNote = '';
  try {
    const seasons = request.seasons ? JSON.parse(request.seasons) : null;
    if (seasons?.length) seasonNote = ` (S${seasons.join(', S')})`;
  } catch (err) {
    seasonNote = '';
  }

  if (request.status === null) return `**${title}**${seasonNote} - waiting for approval`;
  if (request.status === false) return `**${title}**${seasonNote} - denied`;
  if (request.media?.is_available) return `**${title}**${seasonNote} - available`;

  const watch = core.apps.watches.get(request.id);
  if (watch) {
    // BOT REQUESTS ONLY LAND ON ARRS - THEIR QUEUE ROWS CARRY movieId/seriesId
    const queue = core.apps.queueCache.get(watch.appId) || [];
    for (const row of queue) {
      if (String(row.raw?.movieId) === String(watch.arrId) || String(row.raw?.seriesId) === String(watch.arrId)) {
        const left = row.timeleft ? ` - ${row.timeleft} left` : '';
        return `**${title}**${seasonNote} - downloading ${Math.round(row.percent)}%${left}`;
      }
    }
    return `**${title}**${seasonNote} - approved, searching for a release`;
  }
  return `**${title}**${seasonNote} - approved, waiting on the download`;
}

// THE `!df status` / `/status` ANSWER FOR ONE USER
async function buildStatusReply(core, discordUserId) {
  const requests = await core.prisma.mediaRequest.findMany({
    where: { users: { some: { id: discordUserId } } },
    include: { media: true },
    orderBy: { created_at: 'desc' },
    take: 50
  });

  const open = requests.filter(request =>
    request.status === null || (request.status === true && !request.media?.is_available)
  );
  const recentDone = requests.filter(request =>
    request.status === false || (request.status === true && request.media?.is_available)
  ).slice(0, 3);

  if (!open.length && !recentDone.length) {
    return "You haven't made any requests yet.";
  }

  const lines = [];
  if (open.length) {
    lines.push('**Your open requests**');
    open.slice(0, MAX_STATUS_ROWS).forEach(request => lines.push(describeRequest(core, request)));
    if (open.length > MAX_STATUS_ROWS) lines.push(`...and ${open.length - MAX_STATUS_ROWS} more`);
  }
  if (recentDone.length) {
    lines.push(open.length ? '\n**Recently settled**' : '**Recently settled**');
    recentDone.forEach(request => lines.push(describeRequest(core, request)));
  }
  return lines.join('\n');
}

module.exports = { buildStatusReply };
