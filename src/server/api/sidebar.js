const { compileView } = require('../../shared/utils/common');
const { updateState, getState } = require('../../shared/models/state');
const { getServerTemplateObj } = require('./discordServer');
const { updateServer } = require('../../shared/models/discordServer');

const endpointToStateKey = {
  '/toggle-bot': 'discord_state',
  '/toggle-power': 'app_state',
  '/toggle-sidebar': 'sidebar_exp_state',
};

async function toggleSidebarState(ctx) {
    const currentState = await getState();
    const serverTemplateObj = await getServerTemplateObj();

    const stateKey = endpointToStateKey[ctx.request.url];
    if (stateKey) {
      currentState[stateKey] = !currentState[stateKey];
      await updateState(currentState);
    }
    ctx.status = 200;
    ctx.body = await compileView('sideBar.pug', {
      state: currentState,
      servers: serverTemplateObj
    });
}

async function changeActiveServers(ctx) {
  const newActiveServerID = Number.parseInt(ctx.params.id);

  await updateServer({ active_ui_state: true }, { active_ui_state: false });
  await updateServer({ id: newActiveServerID }, { active_ui_state: true });

  const serverTemplateObj = await getServerTemplateObj();

  ctx.status = 200;
  ctx.body = await compileView('servers.pug', {
    servers: serverTemplateObj
  });
  
  ctx.body += await compileView('serverBanner.pug', {
    servers: serverTemplateObj
  });
}

module.exports = {
  toggleSidebarState,
  changeActiveServers
};
