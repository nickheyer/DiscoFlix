const _ = require("lodash");
const { buildSectionNav } = require('./apps');

async function toggleSidebarState(ctx) {
  try {
    const state = await ctx.updateView({
      sidebar_exp_state: !ctx.viewState.sidebar_exp_state
    });

    // MOBILE FLIPS THE DRAWER CLASS CLIENT-SIDE SO THE SLIDE CAN ANIMATE -
    // THIS POST ONLY PERSISTS THE STATE, NOBODY READS THE SIDEBAR RENDER
    if (ctx.get('DF-Mobile') === '1') {
      ctx.status = 204;
      return;
    }

    const [servers, discordBot, apps, activeApp, config] = await Promise.all([
      ctx.core.render.getServerTemplateObj(null, state),
      ctx.core.models.discordBot.get(),
      ctx.core.apps.getRailViewModel(state),
      ctx.core.apps.getInstance(state.active_app_id),
      ctx.core.models.configuration.get()
    ]);
    // DURING A TAKEOVER sidebarLayout INCLUDES THE APP CHANNEL LIST
    await ctx.compileView('sidebar/sidebarLayout.pug', {
      state, servers, discordBot, apps, activeApp,
      authEnabled: !!config.admin_password,
      ...(activeApp ? buildSectionNav(ctx.core, activeApp, config) : {})
    });
  } catch (err) {
    ctx.core.logger.error('TOGGLE_SIDEBAR_FAILED:', err);
    ctx.status = 500;
    return { error: 'Failed to toggle sidebar' };
  }
}

async function changeActiveServers(ctx) {
  try {
    const active_server_id = ctx.params.id;
    // CLICKING A GUILD IS ALSO THE WAY OUT OF AN APP TAKEOVER
    const state = await ctx.updateView({ active_server_id, active_app_id: null });

    const [msgObjects, servers, discordBot, members, apps] = await Promise.all([
      ctx.core.discord.updateMessages(null, state),
      ctx.core.render.getServerTemplateObj(null, state),
      ctx.core.models.discordBot.get(),
      ctx.core.render.getServerMembers(active_server_id),
      ctx.core.apps.getRailViewModel(state)
    ]);

    const history = ctx.core.discord.historyCursorOf(msgObjects);
    const messages = await ctx.core.discord.compileMessages(msgObjects);
    const eomStamp = _.get(_.last(msgObjects), 'created_at');

    await ctx.compileView([
      'sidebar/servers/serverSortableContainer.pug',
      'sidebar/servers/appRail.pug',
      'sidebar/servers/serverHomeButton.pug',
      'sidebar/servers/serverBannerContainer.pug',
      'sidebar/channels/channelsLayout.pug',
      'chat/messageChannelHeader.pug',
      'chat/chatBar.pug',
      'chat/messageContainer.pug',
      'chat/jumpToPresentBar.pug',
      'members/membersLayout.pug',
    ], { servers, discordBot, messages, eomStamp, state, members, apps, history });
  } catch (err) {
    ctx.core.logger.error('CHANGE_SERVER_FAILED:', err);
    ctx.status = 500;
    return { error: 'Failed to change server' };
  }
}

async function changeServerSortOrder(ctx) {
  const newSortOrder = await ctx.core.models.discordServer.reorder(ctx.request.body.item);
  const servers = await ctx.core.render.getServerTemplateObj(newSortOrder, ctx.viewState);
  await ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug'
  ], { servers });
}

async function changeActiveChannel(ctx) {
  const core = ctx.core;
  const active_channel_id = `${ctx.params.id}`;
  // ON PHONES A CHANNEL PICK ALSO CLOSES THE NAV DRAWER - PERSIST BEFORE
  // ANY FRAGMENT COMPILES SO EVERY EMIT RENDERS THE COLLAPSED STATE
  if (ctx.get('DF-Mobile') === '1' && ctx.viewState.sidebar_exp_state) {
    await ctx.updateView({ sidebar_exp_state: false });
  }
  const messages = await core.discord.updateMessages(active_channel_id, ctx.viewState);

  // THE PICK JUST PERSISTED - RE-MERGE SO THE CHROME COMPILE SEES IT
  const view = await core.models.viewSession.viewStateOf(ctx.view.id);
  const html = await core.discord.buildMirrorFragments(view, messages);
  await core.sockets.emitToSession(ctx.view.id, html);

  // READING THE CHANNEL LOWERED ITS BADGES - EVERY OTHER BROWSER CATCHES UP
  const [serverRow, channelRow] = await Promise.all([
    core.models.discordServer.getById(view.active_server_id),
    core.models.discordChannel.getById(active_channel_id)
  ]);
  if (serverRow) {
    await core.discord.emitUnreadBadges(serverRow, channelRow, ctx.view.id);
  }
  await ctx.deferToWS();
}

module.exports = {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder,
  changeActiveChannel
}
