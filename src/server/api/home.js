const { getAllUsers } = require('../../shared/models/user');

async function renderHome(ctx) {
  const today = new Date(Date.now());
  const users = await getAllUsers();
  
  await ctx.render('index', {
    message: `Today's date is ${today.toLocaleString()}`,
    users
  });
}

module.exports = {
  renderHome
}