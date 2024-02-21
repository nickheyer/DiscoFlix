
async function toggleBotState(ctx) {
  const currentState = await ctx.core.state.get();
  if (!currentState['discord_state']) {
    await ctx.core.startBot();
  } else {
    await ctx.core.stopBot();
  }
  await ctx.deferToWS();
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
