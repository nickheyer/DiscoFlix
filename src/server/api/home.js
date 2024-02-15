
async function renderHome(ctx) {
  const state = await ctx.core.state.get();
  const servers = await ctx.core.getServerTemplateObj(null, state);
  const discordBot = await ctx.core.discordBot.get();
  await ctx.render('index', { state, servers, discordBot });
}

module.exports = {
  renderHome
}
