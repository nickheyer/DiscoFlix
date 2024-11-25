const Router = require('koa-router');
const {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder,
  changeActiveChannel,
  toggleSettings
} = require('../api/sidebar');

const {
  toggleBotState,
  toggleAppState
} = require('../api/userControls');

const {
  settingsModal
} = require('../api/modals');

const router = new Router();

router.get('/toggle-sidebar', toggleSidebarState);
router.get('/toggle-bot', toggleBotState);
router.get('/toggle-power', toggleAppState);
router.get('/toggle-settings/:action', toggleSettings);
router.get('/change-active-server/:id', changeActiveServers);
router.get('/change-active-channel/:id', changeActiveChannel);
router.get('/modal/:type/:modal', settingsModal);
router.post('/server-sort', changeServerSortOrder);

module.exports = router;