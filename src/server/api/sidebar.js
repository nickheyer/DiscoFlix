const { updateState, getState } = require('../../shared/models/state');
const pug = require('pug');
const path = require('path');

const sideBarView = path.resolve(__dirname, '..', 'views', 'components', 'sideBar.pug');

async function toggleSidebarState(ctx) {
  try {
    const currState = (await getState()).sidebar_exp;
    const incomingState = !currState;
    await updateState({ sidebar_exp: incomingState })
    ctx.status = 200;
    ctx.body = pug.renderFile(sideBarView, {
      sidebar_expanded: incomingState ? 'expanded' : ''
    });
  } catch (error) {
    ctx.status = 500;
    ctx.body = { message: error.message };
  }
}


module.exports = {
  toggleSidebarState
};
