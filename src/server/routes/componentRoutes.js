const Router = require('koa-router');
const { toggleSidebarState, changeActiveServers, changeServerSortOrder } = require('../api/sidebar');

const router = new Router();

router.get('/toggle-sidebar', toggleSidebarState);
router.get('/toggle-bot', toggleSidebarState);
router.get('/toggle-power', toggleSidebarState);
router.get('/change-active-server/:id', changeActiveServers);

router.post('/server-sort', changeServerSortOrder);

module.exports = router;