const { getState } = require('../../shared/models/state');

async function renderHome(ctx) {
  const currState = await getState();
  const sidebar_exp = currState.sidebar_exp;
  await ctx.render('index', {
    sidebar_expanded: sidebar_exp ? 'expanded' : ''
  });
}

module.exports = {
  renderHome
}
