const _ = require('lodash');


async function renderHome(ctx) {
  const state = await ctx.core.state.get();
  const servers = await ctx.core.getServerTemplateObj(null, state);
  const discordBot = await ctx.core.discordBot.get();
  const messageData = await ctx.core.updateMessages(null, state);
  const messages = await ctx.core.compileMessages(messageData);
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
