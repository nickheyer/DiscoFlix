
async function toggleBotState(ctx) {
  const state = await ctx.core.state.get();
  const discordBot = await ctx.core.discordBot.get();
  state['discord_state'] = !state['discord_state'];

  // FORCE LOADER - ATTACHED TO BODY OF RESPONSE
  await ctx.compileView('modals/bot/power.pug', { state, discordBot, loading: state['discord_state'] });

  if (state['discord_state']) {
    setTimeout(async () => {
      // EMIT FAIL STATE NOW IF IMMEDIATE FAILURE - ELSE DEFER TILL DISCORD CLIENT API EVALS
      state['discord_state'] = await ctx.core.startBot();
      if (!state['discord_state']) {
        // FAIL 'AFTER' RESPONSE BODY IS SENT TO UI - EMIT THE 'REAL' VERDICT AFTER RESPONSE
        await ctx.core.emitCompiled('modals/bot/power.pug', { state, discordBot, loading: false });
      }
    }, 500);
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
