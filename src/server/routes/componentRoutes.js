const Router = require('koa-router');
const {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder
} = require('../api/sidebar');
const {
  toggleBotState,
  toggleAppState
} = require('../api/userControls');

const router = new Router();

router.get('/toggle-sidebar', toggleSidebarState);
router.get('/toggle-bot', toggleBotState);
router.get('/toggle-power', toggleAppState);
router.get('/change-active-server/:id', changeActiveServers);

router.post('/server-sort', changeServerSortOrder);

module.exports = router;