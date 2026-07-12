const CONTENT_SERVICES = { movie: 'radarr', show: 'sonarr' };

// ONE QUEUE FETCH PER CONFIGURED SERVICE - DASHBOARD ROWS CAN SHOW LIVE DOWNLOAD STATE
async function loadRequestViews(core) {
  const [requests, config] = await Promise.all([
    core.models.mediaRequest.getMany(
      {},
      { media: true, users: true, made_in: true },
      { created_at: 'desc' },
      { take: 100 }
    ),
    core.models.configuration.get()
  ]);

  const queues = {};
  for (const service of Object.values(CONTENT_SERVICES)) {
    const client = core.arr.getClientFor(service, config);
    if (!client) continue;
    try {
      queues[service] = await client.getQueue();
    } catch (err) {
      core.logger.warn(`Dashboard could not read ${service} queue: ${err.message}`);
    }
  }

  return requests.map(request => {
    const service = CONTENT_SERVICES[request.orig_parsed_type];
    const client = core.arr.getClientFor(service, config);
    const watch = core.arr.watches.get(request.id);
    const queueRecord = (watch && client && queues[service])
      ? queues[service].find(record => client.matchesQueueRecord(record, watch.arrId))
      : null;
    return core.arr.buildRequestView(request, queueRecord);
  });
}

async function renderRequestDashboard(ctx) {
  const requests = await loadRequestViews(ctx.core);
  return ctx.compileView('modals/requests/dashboard.pug', { requests });
}

async function postVerdict(core, request, approved) {
  if (!request.orig_channel_id) return;
  if (!core.client || !core.client.isReady()) {
    core.logger.warn('Verdict not posted to Discord: bot offline');
    return;
  }
  try {
    const mentions = (request.users || []).map(user => `<@${user.id}>`).join(' ');
    const title = request.media?.title || request.orig_parsed_title;
    const verdict = approved
      ? `✅ ${mentions} Your request for **${title}** was approved — I'll post updates here as it downloads.`
      : `🚫 ${mentions} Your request for **${title}** was denied.`;
    const channel = await core.client.channels.fetch(request.orig_channel_id);
    await channel.send(verdict);
  } catch (err) {
    core.logger.warn(`Verdict post failed: ${err.message}`);
  }
}

// RESPONDS WITH THE FRESH ROW
async function respondWithRow(ctx, requestId, message) {
  const request = await ctx.core.models.mediaRequest.getWithRelations(requestId);
  const req = ctx.core.arr.buildRequestView(request);
  return ctx.compileView(['modals/requests/rowResponse.pug'], { req, message });
}

async function approveRequest(ctx) {
  const core = ctx.core;
  const requestId = ctx.params.id;
  const request = await core.models.mediaRequest.getWithRelations(requestId);
  if (!request) {
    ctx.status = 404;
    return;
  }

  let message = 'Request approved';
  if (request.status !== null) {
    message = 'Request was already decided';
  } else {
    try {
      const config = await core.models.configuration.get();
      const service = CONTENT_SERVICES[request.orig_parsed_type];
      const client = core.arr.getClientFor(service, config);
      if (!client) throw new Error(`${service} is not configured`);

      const externalKey = service === 'radarr' ? request.media.tmdb_id : request.media.tvdb_id;
      if (!externalKey) throw new Error('Media row is missing its external id');

      // ALREADY IN THE LIBRARY (E.G. ADDED BY HAND SINCE THE REQUEST)? SKIP THE ADD.
      let added = await client.getByExternalId(externalKey);
      if (!added) {
        const result = await client.lookupByExternalId(externalKey);
        if (!result) throw new Error(`Lookup found nothing for ${service} id ${externalKey}`);
        added = await client.add(result);
      }

      const imported = client.isImported(added);
      await core.models.mediaRequest.updateStatus(requestId, true);
      await core.models.media.updateMediaInfo(request.media.id, {
        path: added.path || null,
        monitored: true,
        is_available: imported
      });

      if (!imported) {
        core.arr.watchRequest({
          requestId,
          service,
          arrId: added.id,
          mediaId: request.media.id,
          title: request.media.title,
          channelId: request.orig_channel_id,
          requesterIds: (request.users || []).map(user => user.id)
        });
      }

      await postVerdict(core, request, true);
      core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CHIPS
    } catch (err) {
      core.logger.error('Request approval failed:', err);
      message = `Approval failed: ${err.message}`;
    }
  }

  return respondWithRow(ctx, requestId, message);
}

async function denyRequest(ctx) {
  const core = ctx.core;
  const requestId = ctx.params.id;
  const request = await core.models.mediaRequest.getWithRelations(requestId);
  if (!request) {
    ctx.status = 404;
    return;
  }

  let message = 'Request denied';
  if (request.status !== null) {
    message = 'Request was already decided';
  } else {
    await core.models.mediaRequest.updateStatus(requestId, false);
    await postVerdict(core, request, false);
    core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CHIPS
  }

  return respondWithRow(ctx, requestId, message);
}

module.exports = {
  renderRequestDashboard,
  approveRequest,
  denyRequest
};
