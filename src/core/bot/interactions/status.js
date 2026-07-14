const ui = require('./ui');

const MAX_STATUS_ROWS = 10;

// ONE BLOCK PER REQUEST - LIVE QUEUE STATE RIDES THE HEARTBEAT'S CACHE SO
// STATUS NEVER BLOCKS ON SERVICE HTTP
function requestBlock(core, request) {
  const title = request.media?.title || request.orig_parsed_title || 'Unknown';
  let seasonNote = '';
  try {
    const seasons = request.seasons ? JSON.parse(request.seasons) : null;
    if (seasons?.length) seasonNote = ` (S${seasons.join(', S')})`;
  } catch (err) {
    seasonNote = '';
  }
  const headline = `**${title}**${seasonNote}`;

  if (request.status === null) return `${headline}\n-# Waiting for approval`;
  if (request.status === false) return `${headline}\n-# Denied`;
  if (request.media?.is_available) return `${headline}\n-# Available - go stream it`;

  const watch = core.apps.watches.get(request.id);
  if (watch) {
    // BOT REQUESTS ONLY LAND ON ARRS - THEIR QUEUE ROWS CARRY movieId/seriesId
    const queue = core.apps.queueCache.get(watch.appId) || [];
    for (const row of queue) {
      if (String(row.raw?.movieId) === String(watch.arrId) || String(row.raw?.seriesId) === String(watch.arrId)) {
        const left = row.timeleft ? ` - ${row.timeleft} left` : '';
        return `${headline}\n-# Downloading ${ui.progressBar(row.percent)}${left}`;
      }
    }
    return `${headline}\n-# Approved - searching for a release`;
  }
  return `${headline}\n-# Approved - waiting on the download`;
}

// THE `!df status` / `/status` ANSWER FOR ONE USER
async function buildStatusPayload(core, discordUserId) {
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
    return ui.notice("You haven't made any requests yet.");
  }

  const parts = [];
  if (open.length) {
    parts.push(ui.text('### Your open requests'), ui.separator());
    open.slice(0, MAX_STATUS_ROWS).forEach(request => parts.push(ui.text(requestBlock(core, request))));
    if (open.length > MAX_STATUS_ROWS) parts.push(ui.text(`-# ...and ${open.length - MAX_STATUS_ROWS} more`));
  }
  if (recentDone.length) {
    if (parts.length) parts.push(ui.separator({ large: true }));
    parts.push(ui.text('### Recently settled'), ui.separator());
    recentDone.forEach(request => parts.push(ui.text(requestBlock(core, request))));
  }
  return ui.payload(ui.container(parts));
}

module.exports = {
  id: 'status',
  slash: { name: 'status', description: 'Your open requests and their download progress' },
  options: [],
  aliases: ['status'],
  // STATUS IS PERSONAL - SLASH ANSWERS EPHEMERAL, IN GUILDS AND DMS ALIKE
  ephemeral: true,
  feature: {
    id: 'status',
    label: 'Request status',
    description: 'Check open requests and their download progress with /status',
    group: 'core',
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: []
  },
  async available() { return true; },
  async run(ctx) {
    await ctx.send(await buildStatusPayload(ctx.core, ctx.dbUser.id));
  },
  buildStatusPayload
};
