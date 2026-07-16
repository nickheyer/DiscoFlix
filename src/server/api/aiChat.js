const {
  buildTakeoverLocals,
  buildAiMessageViewModels,
  respondWithTakeover
} = require('./apps');

// THE AI CHAT SECTION'S ROUTES. SEND FOLLOWS THE CHAT MIRROR'S CONTRACT:
// THE HTTP RESPONSE IS SILENT (hx-swap="none") AND EVERY VISIBLE CHANGE -
// THE OPERATOR'S BUBBLE, THE TYPING ROW, THE ASSISTANT'S REPLY - ARRIVES
// OVER THE PAGE SOCKET AS ID-KEYED OOB FRAGMENTS, SO EVERY BROWSER ON THE
// SAME THREAD STAYS IN AGREEMENT.

async function resolveAiInstance(ctx) {
  const instance = await ctx.core.apps.getInstance(ctx.params.id);
  if (!instance || ctx.core.apps.getType(instance.app_type)?.kind !== 'ai-provider') {
    ctx.status = 404;
    return null;
  }
  return instance;
}

// THE SHARED RESPONSE FOR THREAD CRUD - LAND ON (OR STAY IN) THE CHAT
// SECTION WITH FRESH SURFACE + RAIL. ENTERS THE TAKEOVER WHEN NEEDED.
async function respondWithAiChat(ctx, instance) {
  const core = ctx.core;
  await core.models.app.update({ id: instance.id }, { active_section: 'chat' });
  instance.active_section = 'chat';

  let state = ctx.viewState;
  if (state.active_app_id !== instance.id) {
    state = await ctx.updateView({ active_app_id: instance.id });
    return respondWithTakeover(ctx, instance, state);
  }

  const takeover = await buildTakeoverLocals(core, instance, { viewState: state });
  return ctx.compileView([
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'members/membersLayout.pug'
  ], { state, members: [], ...takeover });
}

// ONE MESSAGE ROW (+ TYPING CHOREOGRAPHY) PUSHED TO EVERY BROWSER - VIEWERS
// WITHOUT THIS THREAD'S LOG ON SCREEN SIMPLY HAVE NO SWAP TARGET
async function pushAiFragment(core, instance, threadId, { row = null, typing = null } = {}) {
  try {
    const html = await core.render.compile('apps/sections/aiChatPush.pug', {
      activeApp: instance,
      threadId,
      row,
      typing // 'add' | 'remove' | null
    });
    await core.sockets.emit(html);
  } catch (err) {
    core.logger.warn(`AI chat push failed: ${err.message}`);
  }
}

// POST /apps/:id/ai/send - VALIDATE, ACK SILENTLY, RUN THE TURN IN THE
// BACKGROUND. THE OPERATOR BUBBLE LANDS THE MOMENT IT PERSISTS; THE
// ASSISTANT ROW (SUCCESS OR PERSISTED ERROR) REPLACES THE TYPING ROW.
async function aiChatSend(ctx) {
  const core = ctx.core;
  const instance = await resolveAiInstance(ctx);
  if (!instance) return;
  const toast = (message) => ctx.compileView(['extra/notification.pug'], { message });

  const text = String(ctx.request.body?.message || '').trim().slice(0, 4000);
  if (!text) return toast('Say something first');
  if (!core.apps.getClientForInstance(instance)) {
    return toast(`${instance.display_name} is not fully configured - finish Settings first`);
  }
  const thread = await core.models.aiConversation.get({ id: String(ctx.request.body?.threadId || '') });
  if (!thread || thread.appId !== instance.id) {
    return toast('That conversation is gone - start a new one');
  }

  core.ai.runConsoleTurn(instance, thread.id, text, {
    onUserPersisted: async (userRow) => {
      const [row] = buildAiMessageViewModels(core, [userRow], instance);
      await pushAiFragment(core, instance, thread.id, { row, typing: 'add' });
    }
  }).then(async ({ assistantRow }) => {
    const [row] = buildAiMessageViewModels(core, [assistantRow], instance);
    await pushAiFragment(core, instance, thread.id, { row, typing: 'remove' });
  }).catch(async (err) => {
    core.logger.error('AI console send failed:', err);
    await pushAiFragment(core, instance, thread.id, { typing: 'remove' });
  });

  // SILENT SUCCESS - THE BUBBLES LANDING OVER THE SOCKET ARE THE FEEDBACK
  ctx.body = '';
  ctx.type = 'html';
}

// POST /apps/:id/ai/thread/new
async function aiChatNewThread(ctx) {
  const core = ctx.core;
  const instance = await resolveAiInstance(ctx);
  if (!instance) return;
  const thread = await core.models.aiConversation.createConsoleThread(instance.id);
  if (ctx.view?.id) await core.models.viewSession.setAiThreadPick(ctx.view.id, instance.id, thread.id);
  return respondWithAiChat(ctx, instance);
}

// POST /apps/:id/ai/thread/:threadId - SWITCH THIS BROWSER TO A THREAD
async function aiChatOpenThread(ctx) {
  const core = ctx.core;
  const instance = await resolveAiInstance(ctx);
  if (!instance) return;
  const thread = await core.models.aiConversation.get({ id: ctx.params.threadId });
  if (!thread || thread.appId !== instance.id) {
    ctx.status = 404;
    return;
  }
  if (ctx.view?.id) await core.models.viewSession.setAiThreadPick(ctx.view.id, instance.id, thread.id);
  return respondWithAiChat(ctx, instance);
}

// DELETE /apps/:id/ai/thread/:threadId - MESSAGES CASCADE WITH THE ROW
async function aiChatDeleteThread(ctx) {
  const core = ctx.core;
  const instance = await resolveAiInstance(ctx);
  if (!instance) return;
  const thread = await core.models.aiConversation.get({ id: ctx.params.threadId });
  if (!thread || thread.appId !== instance.id) {
    ctx.status = 404;
    return;
  }
  await core.models.aiConversation.safeDelete(thread.id);
  if (ctx.view?.id) await core.models.viewSession.setAiThreadPick(ctx.view.id, instance.id, null);
  core.logger.info(`AI conversation deleted: "${thread.title}" (${instance.display_name})`);
  return respondWithAiChat(ctx, instance);
}

module.exports = { aiChatSend, aiChatNewThread, aiChatOpenThread, aiChatDeleteThread };
