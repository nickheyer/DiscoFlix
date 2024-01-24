const { getState } = require('../../shared/models/state');
const { getServers } = require('../../shared/models/discordServer');
const { createServerBubbles, createMockServers } = require('./discordServer');

async function renderHome(ctx) {
  const currState = await getState();
  let currServers = await getServers();
  if (currServers.length < 1) {
    currServers = await createMockServers();
  }

  const currServerBubbles = await createServerBubbles(currServers);

  await ctx.render('index', {
    state: currState,
    serverBubbles: currServerBubbles
  });
}

module.exports = {
  renderHome
}
