// ONE QUEUE FETCH PER APP INSTANCE WITH AN ACTIVE WATCH - DASHBOARD ROWS CAN
// SHOW LIVE DOWNLOAD STATE
async function loadRequestViews(core) {
  const requests = await core.models.mediaRequest.getMany(
    {},
    { media: true, users: true, made_in: true, app: true },
    { created_at: 'desc' },
    { take: 100 }
  );

  const queues = new Map();
  const watchedAppIds = new Set(
    requests.map(request => core.apps.watches.get(request.id)?.appId).filter(Boolean)
  );
  for (const appId of watchedAppIds) {
    const instance = await core.apps.getInstance(appId);
    const client = instance?.enabled ? core.apps.getClientForInstance(instance) : null;
    if (!client) continue;
    try {
      queues.set(appId, { client, queue: await client.getQueue() });
    } catch (err) {
      core.logger.warn(`Dashboard could not read ${instance.display_name} queue: ${err.message}`);
    }
  }

  return requests.map(request => {
    const watch = core.apps.watches.get(request.id);
    const watched = watch ? queues.get(watch.appId) : null;
    const queueRow = watched
      ? watched.queue.find(row => watched.client.matchesQueueRecord(row, watch.arrId))
      : null;
    return core.apps.buildRequestView(request, queueRow);
  });
}

// contentType -> [{ id, label }] FOR THE PER-ROW INSTANCE OVERRIDE SELECT
// (ONLY MEANINGFUL WHEN MORE THAN ONE INSTANCE SERVES THE TYPE)
async function buildInstanceOptions(core) {
  const options = {};
  for (const def of core.apps.contentTypeDefs()) {
    const instances = await core.apps.instancesForContentType(def.type);
    options[def.type] = instances.map(instance => ({
      id: instance.id,
      label: instance.display_name,
      isDefault: instance.is_default
    }));
  }
  return options;
}

async function renderRequestDashboard(ctx) {
  const requests = await loadRequestViews(ctx.core);
  const instanceOptions = await buildInstanceOptions(ctx.core);
  return ctx.compileView('modals/requests/dashboard.pug', { requests, instanceOptions });
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
      ? `✅ ${mentions} Your request for **${title}** was approved - I'll post updates here as it downloads.`
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
  const req = ctx.core.apps.buildRequestView(request);
  return ctx.compileView(['modals/requests/rowResponse.pug'], { req, message });
}

// WHICH INSTANCE GETS THE ADD: POSTED OVERRIDE > THE INSTANCE THE SEARCH RAN
// AGAINST (IF STILL SERVING) > THE CURRENT DEFAULT FOR THE CONTENT TYPE
async function resolveApprovalInstance(core, request, postedAppId) {
  const candidates = [];
  if (postedAppId) candidates.push(postedAppId);
  if (request.appId) candidates.push(request.appId);

  for (const appId of candidates) {
    const instance = await core.apps.getInstance(appId);
    if (instance?.enabled && core.apps.isConfigured(instance)) return instance;
  }
  return core.apps.defaultInstanceFor(request.orig_parsed_type);
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
      const instance = await resolveApprovalInstance(core, request, ctx.request.body?.appId);
      if (!instance) throw new Error(`No connected app handles ${request.orig_parsed_type} requests`);
      const client = core.apps.getClientForInstance(instance);

      const externalKey = request.media[client.externalIdField];
      if (!externalKey) throw new Error('Media row is missing its external id');

      // ALREADY IN THE LIBRARY (E.G. ADDED BY HAND SINCE THE REQUEST)? SKIP THE ADD.
      let added = await client.getByExternalId(externalKey);
      if (!added) {
        const result = await client.lookupByExternalId(externalKey);
        if (!result) throw new Error(`Lookup found nothing for ${instance.display_name} id ${externalKey}`);
        added = await client.add(result);
      }

      const imported = client.isImported(added);
      await core.models.mediaRequest.updateStatus(requestId, true);
      // PERSIST THE RESOLVED INSTANCE - THE ROW MAY HAVE BEEN OVERRIDDEN OR ORPHANED
      await core.models.mediaRequest.update({ id: requestId }, { appId: instance.id });
      await core.models.media.updateMediaInfo(request.media.id, {
        path: added.path || null,
        monitored: true,
        is_available: imported
      });

      if (!imported) {
        core.apps.watchRequest({
          requestId,
          appId: instance.id,
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
