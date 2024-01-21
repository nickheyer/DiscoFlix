const Router = require('koa-router');
const homeRoutes = require('./homeRoutes');
const userRoutes = require('./userRoutes');
const componentRoutes = require('./componentRoutes');

// CREATE ROUTER
const router = new Router();

// AGGREGATE ROUTES
router.use(homeRoutes.routes());
router.use(userRoutes.routes());
router.use(componentRoutes.routes());

module.exports = router;
