const { getServerTemplateObj } = require('../../shared/utils/common');
const { updateState, getState } = require('../../shared/models/state');
const { updateServer, reorderServers } = require('../../shared/models/discordServer');

const endpointToStateKey = {
  '/toggle-bot': 'discord_state',
  '/toggle-power': 'app_state',
  '/toggle-sidebar': 'sidebar_exp_state',
};

/**
 * Toggles the expanded/collapsed state of sidebar, as well as power button io state(s).
 * @async
 * @param {Object} ctx - The Koa context object.
 */
async function toggleSidebarState(ctx) {
  const currentState = await getState();
  const serverTemplateObj = await getServerTemplateObj();

  const stateKey = endpointToStateKey[ctx.request.url];
  if (stateKey) {
    currentState[stateKey] = !currentState[stateKey];
    await updateState(currentState);
  }

  await ctx.compileView('nav/sideBar.pug', {
    state: currentState,
    servers: serverTemplateObj
  });
}


/**
 * Changes the active servers' state and renders the server and server banner templates.
 * @async
 * @param {Object} ctx - The Koa context object. Expects `id` in `ctx.params` for the new active server.
 */
async function changeActiveServers(ctx) {
  const newActiveServerID = Number.parseInt(ctx.params.id);

  await updateServer({ active_ui_state: true }, { active_ui_state: false });
  await updateServer({ id: newActiveServerID }, { active_ui_state: true });

  const servers = await getServerTemplateObj();

  await ctx.compileView([
    'nav/servers/servers.pug',
    'nav/servers/serverBanner.pug'
  ], { servers });
}

async function changeServerSortOrder(ctx) {
  const newSortOrder = await reorderServers(ctx.request.body.item);
  const servers = await getServerTemplateObj(newSortOrder);

  await ctx.compileView([
    'nav/servers/servers.pug'
  ], { servers });
}

module.exports = {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder
};
