const _ = require("lodash");

async function toggleSidebarState(ctx) {
  const state = await ctx.core.state.get();
  const servers = await ctx.core.getServerTemplateObj(null, state);
  state['sidebar_exp_state'] = !state['sidebar_exp_state'];
  await ctx.core.state.update(state);
  const discordBot = await ctx.core.discordBot.get();
  await ctx.compileView('sidebar/sidebarLayout.pug', { state, servers, discordBot });
}

async function changeActiveServers(ctx) {
  const active_server_id = `${ctx.params.id}`;
  const state = await ctx.core.state.update({ active_server_id });
  const msgObjects = await ctx.core.updateMessages(null, state);
  const messages = await ctx.core.compileMessages(msgObjects);
  const servers = await ctx.core.getServerTemplateObj(null, state);
  const discordBot = await ctx.core.discordBot.get();
  const eomStamp = _.get(_.last(msgObjects), 'created_at');
  await ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug',
    'sidebar/servers/serverBannerLabel.pug',
    'sidebar/channels/chatChannels.pug',
    'chat/messageChannelHeader.pug',
    'chat/chatBar.pug',
    'chat/messageContainer.pug'
  ], { servers, discordBot, messages, eomStamp });
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
}

module.exports = {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder,
  changeActiveChannel
};
