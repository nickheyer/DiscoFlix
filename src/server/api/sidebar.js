
async function toggleSidebarState(ctx) {
  const state = await ctx.core.state.get();
  const servers = await ctx.core.getServerTemplateObj(null, state);
  state['sidebar_exp_state'] = !state['sidebar_exp_state'];
  await ctx.core.state.update(state);
  const discordBot = await ctx.core.discordBot.get();
  await ctx.compileView('nav/sideBar.pug', { state, servers, discordBot });
}

async function changeActiveServers(ctx) {
  const active_server_id = `${ctx.params.id}`;
  const state = await ctx.core.state.update({ active_server_id });
  const servers = await ctx.core.getServerTemplateObj(null, state);
  const discordBot = await ctx.core.discordBot.get();
  await ctx.compileView([
    'nav/servers/servers.pug',
    'nav/servers/serverBanner.pug'
  ], { servers, discordBot });
}

async function changeServerSortOrder(ctx) {
  const newSortOrder = await ctx.core.discordServer.reorder(ctx.request.body.item);
  const servers = await ctx.core.getServerTemplateObj(newSortOrder);
  const discordBot = await ctx.core.discordBot.get();
  await ctx.compileView([
    'nav/servers/servers.pug'
  ], { servers, discordBot });
}

module.exports = {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder
};
