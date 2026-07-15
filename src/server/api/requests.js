// REQUESTS SECTION SEARCH + FILTER TABS - SWAPS THE WHOLE BODY SO TABS,
// COUNTS, AND CARDS ALWAYS AGREE (SAME PATTERN AS THE USERS SECTION)
async function appRequestsBody(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return;
  }
  const requests = await core.apps.getRequestsPage({
    search: String(ctx.query.search || '').trim(),
    filter: String(ctx.query.filter || '').trim()
  });
  return ctx.compileView('apps/sections/dfRequestsBody.pug', {
    activeApp: instance,
    requests,
    instanceOptions: await core.apps.buildInstanceOptions()
  });
}

// REQUESTS PAGINATION - THE VIEW MORE SENTINEL SWAPS ITSELF FOR BARE CARDS
async function appRequestsPage(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance || instance.app_type !== 'discoflix') {
    ctx.status = 404;
    return;
  }
  const requests = await core.apps.getRequestsPage({
    page: Math.max(1, parseInt(ctx.params.page, 10) || 1),
    search: String(ctx.query.search || '').trim(),
    filter: String(ctx.query.filter || '').trim()
  });
  return ctx.compileView('apps/sections/dfRequestCards.pug', {
    activeApp: instance,
    requests,
    instanceOptions: await core.apps.buildInstanceOptions()
  });
}

async function postVerdict(core, request, approved) {
  if (!request.orig_channel_id) return;
  if (!core.client || !core.client.isReady()) {
    core.logger.warn('Verdict not posted to Discord: bot offline');
    return;
  }
  try {
    const ui = require('../../core/bot/interactions/ui');
    const mentions = (request.users || []).map(user => `<@${user.id}>`).join(' ');
    const title = request.media?.title || request.orig_parsed_title;
    const verdict = approved
      ? ui.notice(`${mentions} Your request for **${title}** was approved.`, { accent: 'ok', subtext: 'Updates will land here as it downloads' })
      : ui.notice(`${mentions} Your request for **${title}** was denied.`, { accent: 'danger' });
    const channel = await core.client.channels.fetch(request.orig_channel_id);
    await channel.send(verdict);
  } catch (err) {
    core.logger.warn(`Verdict post failed: ${err.message}`);
  }
}

// APPROVE/DENY RESPONSE CONTRACT: EVERY SURFACE'S BUTTONS POST hx-swap="none",
// THE HTTP RESPONSE CARRIES ONLY THE TOAST, AND pushRequestCard BROADCASTS
// THE FRESH CARD TO EVERY SURFACE AT ONCE (SECTION + CHAT, ID-KEYED OOB)
async function respondWithToast(ctx, requestId, message) {
  ctx.core.apps.pushRequestCard(requestId).catch(() => {});
  return ctx.compileView(['extra/notification.pug'], { message });
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
        // THE REQUESTER'S SEASON PICK RIDES THE ROW - MONITOR EXACTLY THAT
        let seasons = null;
        try { seasons = request.seasons ? JSON.parse(request.seasons) : null; } catch (err) { seasons = null; }
        added = await client.add(result, { seasons });
      }

      const imported = client.isImported(added);
      await core.models.mediaRequest.updateStatus(requestId, true);
      // PERSIST THE RESOLVED INSTANCE AND SERVICE ITEM ID - THE ROW MAY HAVE
      // BEEN OVERRIDDEN OR ORPHANED, AND A RESTART RE-ARMS WATCHES FROM THESE
      await core.models.mediaRequest.update(
        { id: requestId },
        { appId: instance.id, arr_id: String(added.id) }
      );
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
          requesterIds: (request.users || []).map(user => user.id),
          featureId: request.orig_parsed_type ? `request.${request.orig_parsed_type}` : null,
          serverId: request.madeInId
        });
      }

      await postVerdict(core, request, true);
    } catch (err) {
      core.logger.error('Request approval failed:', err);
      message = `Approval failed: ${err.message}`;
    }
  }

  return respondWithToast(ctx, requestId, message);
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
  }

  return respondWithToast(ctx, requestId, message);
}

// JUMP TO THE TRIGGERING MESSAGE: POINT THE MIRROR AT THE ORIGIN SERVER +
// CHANNEL, RESPOND WITH THE FULL MIRROR SWAP, AND FLASH THE ROW ONCE LANDED.
// TARGETS DEEPER THAN THE NEWEST PAGE TIME-TRAVEL: THE VIEW ANCHORS ON A
// WINDOW AROUND THE MESSAGE (SENTINELS BOTH WAYS + THE JUMP-TO-PRESENT BAR).
async function jumpToRequestMessage(ctx) {
  const core = ctx.core;
  const request = await core.models.mediaRequest.getWithRelations(ctx.params.id);
  if (!request || !request.orig_message_id || !request.orig_channel_id || !request.madeInId) {
    ctx.status = 404;
    return;
  }

  await core.models.discordServer.update(
    { server_id: request.madeInId },
    { active_channel_id: request.orig_channel_id }
  );
  // THE JUMP ONLY REPOINTS THE ACTING BROWSER'S VIEW
  await core.models.viewSession.setChannelPick(ctx.view.id, request.madeInId, request.orig_channel_id);

  const { respondWithMirror } = require('./apps');
  const target = await core.prisma.discordMessage.findUnique({
    where: { message_id: request.orig_message_id }
  });

  if (!target || target.channel_id !== request.orig_channel_id) {
    // NEVER MIRRORED (PRE-DATES THE BOT) OR DELETED - HONEST FALLBACK:
    // THE LIVE WINDOW PLUS A TOAST, NO FALSE FLASH
    const state = await ctx.updateView({ active_server_id: request.madeInId, active_app_id: null });
    await respondWithMirror(ctx, state);
    ctx.body += await core.render.compile('extra/notification.pug', {
      message: "Couldn't find the original message in the mirror"
    });
    return;
  }

  const newerCount = await core.models.discordChannel.countNewerThan(
    request.orig_channel_id,
    target.created_at
  );
  if (newerCount < core.models.discordChannel.historyPageSize) {
    // INSIDE THE NEWEST PAGE - THE PLAIN LIVE MIRROR ALREADY LANDS IT
    const state = await ctx.updateView({ active_server_id: request.madeInId, active_app_id: null });
    await respondWithMirror(ctx, state);
  } else {
    await core.models.viewSession.setAnchor(ctx.view.id, request.orig_channel_id, target.message_id);
    const state = await ctx.updateView({ active_server_id: request.madeInId, active_app_id: null });
    await respondWithMirror(ctx, state, {
      anchorTarget: { channel_id: request.orig_channel_id, message_id: target.message_id }
    });
  }
  // THE SCRIPT RIDES AN OOB FRAGMENT SO hx-swap="none" STILL EXECUTES IT
  ctx.body += `<div hx-swap-oob="beforeend:body"><script>window.dfFlashMessage && dfFlashMessage('msg-${request.orig_message_id}')</script></div>`;
}

module.exports = {
  appRequestsBody,
  appRequestsPage,
  approveRequest,
  denyRequest,
  jumpToRequestMessage
};
