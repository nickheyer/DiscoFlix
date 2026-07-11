const _ = require('lodash');


async function renderHome(ctx) {
  const state = await ctx.core.models.state.get();
  const servers = await ctx.core.render.getServerTemplateObj(null, state);
  const discordBot = await ctx.core.models.discordBot.get();
  const messageData = await ctx.core.discord.updateMessages(null, state);
  const messages = await ctx.core.discord.compileMessages(messageData);
  const eomStamp = _.get(_.last(messageData), 'created_at');

  await ctx.render('index', {
    state,
    servers,
    discordBot,
    messages,
    eomStamp
  });
}

module.exports = {
  renderHome
}
