const _ = require('lodash');
const { buildAppRail, buildTakeoverLocals } = require('./apps');


async function renderHome(ctx) {
  const core = ctx.core;
  const state = await core.models.state.get();
  const servers = await core.render.getServerTemplateObj(null, state);
  const discordBot = await core.models.discordBot.get();
  const apps = await buildAppRail(core, state);
  const ticker = core.apps.buildTickerAggregate();

  // APP TAKEOVER SURVIVES RELOAD — THE MIRROR LOCALS ARE SKIPPED ENTIRELY,
  // BACK-OUT RE-RENDERS THEM THROUGH changeActiveServers
  const activeInstance = state.active_app_id
    ? await core.apps.getInstance(state.active_app_id)
    : null;
  if (activeInstance) {
    const takeover = await buildTakeoverLocals(core, activeInstance);
    return ctx.render('index', {
      state,
      servers,
      discordBot,
      messages: [],
      eomStamp: null,
      members: [],
      apps,
      ticker,
      ...takeover
    });
  }

  const messageData = await core.discord.updateMessages(null, state);
  const messages = await core.discord.compileMessages(messageData);
  const eomStamp = _.get(_.last(messageData), 'created_at');
  const members = await core.render.getServerMembers(state.active_server_id);

  await ctx.render('index', {
    state,
    servers,
    discordBot,
    messages,
    eomStamp,
    members,
    apps,
    ticker
  });
}

module.exports = {
  renderHome
}
