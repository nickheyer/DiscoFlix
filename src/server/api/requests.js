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

// APPROVE/DENY RESPONSE CONTRACT: EVERY SURFACE'S BUTTONS POST hx-swap="none",
// THE HTTP RESPONSE CARRIES ONLY THE TOAST, AND pushRequestCard BROADCASTS
// THE FRESH CARD TO EVERY SURFACE AT ONCE (SECTION + CHAT, ID-KEYED OOB)
async function respondWithToast(ctx, requestId, message) {
  ctx.core.apps.pushRequestCard(requestId).catch(() => {});
  return ctx.compileView(['extra/notification.pug'], { message });
}

// THE DECISION ITSELF LIVES ON core.apps (requestActions.js) - THE AI
// OPERATOR TOOLS AND THESE BUTTONS SHARE ONE PATH
async function approveRequest(ctx) {
  const requestId = ctx.params.id;
  const exists = await ctx.core.models.mediaRequest.get({ id: requestId });
  if (!exists) {
    ctx.status = 404;
    return;
  }
  const { message } = await ctx.core.apps.approveMediaRequest(requestId, {
    appId: ctx.request.body?.appId
  });
  return respondWithToast(ctx, requestId, message);
}

async function denyRequest(ctx) {
  const requestId = ctx.params.id;
  const exists = await ctx.core.models.mediaRequest.get({ id: requestId });
  if (!exists) {
    ctx.status = 404;
    return;
  }
  const { message } = await ctx.core.apps.denyMediaRequest(requestId);
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
