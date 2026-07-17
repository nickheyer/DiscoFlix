const _ = require('lodash');
const { buildAppRail, buildTakeoverLocals } = require('./apps');


async function renderHome(ctx) {
  const core = ctx.core;
  const state = ctx.viewState;
  const servers = await core.render.getServerTemplateObj(null, state);
  const discordBot = await core.models.discordBot.get();
  const apps = await buildAppRail(core, state);
  const ticker = core.apps.buildTickerAggregate();
  // THE LOGOUT BUTTON ONLY RENDERS WHEN A PASSWORD GUARDS THE CONSOLE
  const config = await core.models.configuration.get();
  const authEnabled = !!config.admin_password;

  // APP TAKEOVER SURVIVES RELOAD - THE MIRROR LOCALS ARE SKIPPED ENTIRELY,
  // BACK-OUT RE-RENDERS THEM THROUGH changeActiveServers
  const activeInstance = state.active_app_id
    ? await core.apps.getInstance(state.active_app_id)
    : null;
  if (activeInstance) {
    const takeover = await buildTakeoverLocals(core, activeInstance);
    return ctx.renderPage('index', {
      state,
      servers,
      discordBot,
      messages: [],
      eomStamp: null,
      members: [],
      apps,
      ticker,
      authEnabled,
      ...takeover
    });
  }

  const messageData = await core.discord.updateMessages(null, state);
  const history = core.discord.historyCursorOf(messageData);
  const messages = await core.discord.compileMessages(messageData);
  const eomStamp = _.get(_.last(messageData), 'created_at');
  const members = await core.render.getServerMembers(state.active_server_id);

  await ctx.renderPage('index', {
    state,
    servers,
    discordBot,
    messages,
    eomStamp,
    members,
    apps,
    ticker,
    history,
    authEnabled
  });
}

module.exports = {
  renderHome
}
