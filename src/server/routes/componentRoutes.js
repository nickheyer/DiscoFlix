const Router = require('koa-router');
const { toggleSidebarState, getSidebarState } = require('../api/sidebar');

const router = new Router();

router.post('/toggle-sidebar', toggleSidebarState);

module.exports = router;