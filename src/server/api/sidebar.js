const { compileView } = require('../../shared/utils/common');
const { updateState, getState } = require('../../shared/models/state');

const endpointToStateKey = {
  '/toggle-bot': 'discord_state',
  '/toggle-power': 'app_state',
  '/toggle-sidebar': 'sidebar_exp_state'
};

async function toggleSidebarState(ctx) {
    const currentState = await getState();
    const stateKey = endpointToStateKey[ctx.request.url];
    if (stateKey) {
      currentState[stateKey] = !currentState[stateKey];
      await updateState(currentState);
    }
    ctx.status = 200;
    ctx.body = await compileView('sideBar.pug', { state: currentState });
}

module.exports = {
  toggleSidebarState
};
