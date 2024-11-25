
async function toggleBotState(ctx) {
  const state = await ctx.core.state.get();
  const discordBot = await ctx.core.discordBot.get();
  state['discord_state'] = !state['discord_state'];
  await ctx.compileView('modals/bot/power.pug', { state, discordBot, loading: state['discord_state'] });
  if (state['discord_state']) {
    await ctx.core.startBot();
  } else {
    await ctx.core.stopBot();
  }
}

async function toggleAppState(ctx) {
  ctx.response.status = 286;
  await ctx.compileView('sidebar/userControls/userControlShutdown.pug');
  ctx.res.on('finish', async () => {
    await ctx.core.shutdownServer(ctx.request.url);
  });
}

module.exports = {
  toggleBotState,
  toggleAppState
};
