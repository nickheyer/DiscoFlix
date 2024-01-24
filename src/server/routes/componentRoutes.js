const Router = require('koa-router');
const { toggleSidebarState } = require('../api/sidebar');

const router = new Router();

router.get('/toggle-sidebar', toggleSidebarState);
router.get('/toggle-bot', toggleSidebarState);
router.get('/toggle-power', toggleSidebarState);

module.exports = router;