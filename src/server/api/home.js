const { getAllUsers } = require('../../shared/models/user');

async function renderHome(ctx) {
  const today = new Date(Date.now());
  
  await ctx.render('index', {
    message: `Today's date is ${today.toLocaleString()}`,
    title: 'DiscoFlix'
  });
}

module.exports = {
  renderHome
}
