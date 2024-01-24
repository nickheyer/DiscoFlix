const { getState } = require('../../shared/models/state');
const { getServerTemplateObj } = require('./discordServer');

async function renderHome(ctx) {
  const currState = await getState();
  const serverTemplateObj = await getServerTemplateObj();

  await ctx.render('index', {
    state: currState,
    servers: serverTemplateObj
  });
}

module.exports = {
  renderHome
}
