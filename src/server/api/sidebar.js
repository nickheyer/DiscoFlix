const _ = require("lodash");
const { buildSectionNav } = require('./apps');

async function toggleSidebarState(ctx) {
  try {
    const currentState = await ctx.core.models.state.get();
    const state = await ctx.core.models.state.update({
      sidebar_exp_state: !currentState.sidebar_exp_state
    });

    const [servers, discordBot, apps, activeApp] = await Promise.all([
      ctx.core.render.getServerTemplateObj(null, state),
      ctx.core.models.discordBot.get(),
      ctx.core.apps.getRailViewModel(state),
      ctx.core.apps.getInstance(state.active_app_id)
    ]);
    // DURING A TAKEOVER sidebarLayout INCLUDES THE APP CHANNEL LIST
    await ctx.compileView('sidebar/sidebarLayout.pug', {
      state, servers, discordBot, apps, activeApp,
      ...(activeApp ? buildSectionNav(ctx.core, activeApp) : {})
    });
  } catch (err) {
    if (err.code === 'P2002') { // PRISMA CONSTRAINT CODE
      return toggleSidebarState(ctx);
    } else {
      ctx.core.logger.error('TOGGLE_SIDEBAR_FAILED:', err);
      ctx.status = 500;
      return { error: 'Failed to toggle sidebar' };
    }
  }
}

async function changeActiveServers(ctx) {
  try {
    const active_server_id = ctx.params.id;
    // CLICKING A GUILD IS ALSO THE WAY OUT OF AN APP TAKEOVER
    const state = await ctx.core.models.state.update({ active_server_id, active_app_id: null });

    const [msgObjects, servers, discordBot, members, apps, onboarding] = await Promise.all([
      ctx.core.discord.updateMessages(null, state),
      ctx.core.render.getServerTemplateObj(null, state),
      ctx.core.models.discordBot.get(),
      ctx.core.render.getServerMembers(active_server_id),
      ctx.core.apps.getRailViewModel(state),
      ctx.core.render.getOnboarding(state)
    ]);

    const messages = await ctx.core.discord.compileMessages(msgObjects);
    const eomStamp = _.get(_.last(msgObjects), 'created_at');

    await ctx.compileView([
      'sidebar/servers/serverSortableContainer.pug',
      'sidebar/servers/appRail.pug',
      'sidebar/servers/serverBannerContainer.pug',
      'sidebar/userControls/settingsButton.pug',
      'sidebar/channels/channelsLayout.pug',
      'chat/messageChannelHeader.pug',
      'chat/chatBar.pug',
      'chat/messageContainer.pug',
      'members/membersLayout.pug',
    ], { servers, discordBot, messages, eomStamp, state, members, apps, onboarding });
  } catch (err) {
    ctx.core.logger.error('CHANGE_SERVER_FAILED:', err);
    ctx.status = 500;
    return { error: 'Failed to change server' };
  }
}

async function changeServerSortOrder(ctx) {
  const newSortOrder = await ctx.core.models.discordServer.reorder(ctx.request.body.item);
  const servers = await ctx.core.render.getServerTemplateObj(newSortOrder);
  await ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug'
  ], { servers });
}

async function changeActiveChannel(ctx) {
  const state = await ctx.core.models.state.get();
  const active_channel_id = `${ctx.params.id}`;
  const messages = await ctx.core.discord.updateMessages(active_channel_id, state);
  await ctx.core.discord.refreshUI(messages);
  await ctx.deferToWS();
}

async function toggleSettings(ctx) {
  const action = ctx.params.action;
  if (action === 'open') {
    await ctx.compileView([
      'sidebar/servers/serverBannerLabel.pug',
      'sidebar/settings/settingsLayout.pug',
      'sidebar/settings/settingsToggleClose.pug',
      'sidebar/userControls/settingsButtonOpened.pug'
    ], { settingsToggled: true });
  } else {
    const state = await ctx.core.models.state.get();
    const servers = await ctx.core.render.getServerTemplateObj(null, state);
    const discordBot = await ctx.core.models.discordBot.get();
    const apps = await ctx.core.apps.getRailViewModel(state);
    const activeApp = await ctx.core.apps.getInstance(state.active_app_id);
    await ctx.compileView('sidebar/sidebarLayout.pug', {
      state, servers, discordBot, apps, activeApp,
      ...(activeApp ? buildSectionNav(ctx.core, activeApp) : {})
    });
  }

}

module.exports = {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder,
  changeActiveChannel,
  toggleSettings
}
