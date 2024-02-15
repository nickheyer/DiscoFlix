
async function toggleBotState(ctx) {
  const currentState = await ctx.core.state.get();
  if (!currentState['discord_state']) {
    global.logger.info('STARTING BOT');
    await ctx.core.startBot();
  } else {
    global.logger.info('KILLING BOT');
    await ctx.core.stopBot();
  }
  await ctx.deferToWS();
}

async function toggleAppState(ctx) {
  ctx.response.status = 286;
  await ctx.compileView('nav/user/userControlShutdown.pug');
  ctx.res.on('finish', async () => {
    await ctx.core.shutdownServer(ctx.request.url);
  });
}

module.exports = {
  toggleBotState,
  toggleAppState
};
