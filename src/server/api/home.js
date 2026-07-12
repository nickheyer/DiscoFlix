const _ = require('lodash');
const { buildAppRail } = require('./apps');


async function renderHome(ctx) {
  const state = await ctx.core.models.state.get();
  const servers = await ctx.core.render.getServerTemplateObj(null, state);
  const discordBot = await ctx.core.models.discordBot.get();
  const messageData = await ctx.core.discord.updateMessages(null, state);
  const messages = await ctx.core.discord.compileMessages(messageData);
  const eomStamp = _.get(_.last(messageData), 'created_at');
  const members = await ctx.core.render.getServerMembers(state.active_server_id);
  const config = await ctx.core.models.configuration.get();

  await ctx.render('index', {
    state,
    servers,
    discordBot,
    messages,
    eomStamp,
    members,
    apps: buildAppRail(config)
  });
}

module.exports = {
  renderHome
}
