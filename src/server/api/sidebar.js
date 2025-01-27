const _ = require("lodash");

async function toggleSidebarState(ctx) {
  try {
    const currentState = await ctx.core.state.get();
    const state = await ctx.core.state.update({
      sidebar_exp_state: !currentState.sidebar_exp_state 
    });
    
    const [servers, discordBot] = await Promise.all([
      ctx.core.getServerTemplateObj(null, state),
      ctx.core.discordBot.get()
    ]);
    await ctx.compileView('sidebar/sidebarLayout.pug', { state, servers, discordBot });
  } catch (err) {
    if (err.code === 'P2002') { // PRISMA CONSTRAINT CODE
      return toggleSidebarState(ctx);
    } else {
      global.logger.error('TOGGLE_SIDEBAR_FAILED:', err);
      ctx.status = 500;
      return { error: 'Failed to toggle sidebar' };
    }
  }
}

async function changeActiveServers(ctx) {
  try {
    const active_server_id = ctx.params.id;
    const state = await ctx.core.state.update({ active_server_id });
    
    const [msgObjects, servers, discordBot] = await Promise.all([
      ctx.core.updateMessages(null, state),
      ctx.core.getServerTemplateObj(null, state),
      ctx.core.discordBot.get()
    ]);

    const messages = await ctx.core.compileMessages(msgObjects);
    const eomStamp = _.get(_.last(msgObjects), 'created_at');

    await ctx.compileView([
      'sidebar/servers/serverSortableContainer.pug',
      'sidebar/servers/serverBannerContainer.pug',
      'sidebar/userControls/settingsButton.pug',
      'sidebar/channels/channelsLayout.pug',
      'chat/messageChannelHeader.pug',
      'chat/chatBar.pug',
      'chat/messageContainer.pug',
    ], { servers, discordBot, messages, eomStamp, state });
  } catch (err) {
    global.logger.error('CHANGE_SERVER_FAILED:', err);
    ctx.status = 500;
    return { error: 'Failed to change server' };
  }
}

async function changeServerSortOrder(ctx) {
  const newSortOrder = await ctx.core.discordServer.reorder(ctx.request.body.item);
  const servers = await ctx.core.getServerTemplateObj(newSortOrder);
  await ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug'
  ], { servers });
}

async function changeActiveChannel(ctx) {
  const state = await ctx.core.state.get();
  const active_channel_id = `${ctx.params.id}`;
  const messages = await ctx.core.updateMessages(active_channel_id, state);
  await ctx.core.refreshUI(messages);
  await ctx.deferToWS();
}

async function toggleSettings(ctx) {
  global.logger.debug(ctx.params)
  const action = ctx.params.action;
  if (action === 'open') {
    await ctx.compileView([
      'sidebar/servers/serverBannerLabel.pug',
      'sidebar/settings/settingsLayout.pug',
      'sidebar/settings/settingsToggleClose.pug',
      'sidebar/userControls/settingsButtonOpened.pug'
    ], { settingsToggled: true });
  } else {
    const state = await ctx.core.state.get();
    const servers = await ctx.core.getServerTemplateObj(null, state);
    const discordBot = await ctx.core.discordBot.get();
    await ctx.compileView('sidebar/sidebarLayout.pug', { state, servers, discordBot });
  }

}

module.exports = {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder,
  changeActiveChannel,
  toggleSettings
}
