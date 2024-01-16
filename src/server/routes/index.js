const Router = require('koa-router');
const homeRoutes = require('./homeRoutes');
const userRoutes = require('./userRoutes');

// CREATE ROUTER
const router = new Router();

// AGGREGATE ROUTES
router.use(homeRoutes.routes());
router.use(userRoutes.routes());

module.exports = router;
