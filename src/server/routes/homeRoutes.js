const Router = require('koa-router');
const { renderHome } = require('../api/home');

const router = new Router();

router.get('/', renderHome);

module.exports = router;
