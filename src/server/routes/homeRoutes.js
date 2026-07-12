const Router = require('koa-router');
const { renderHome } = require('../api/home');
const { renderLogin, processLogin, processLogout } = require('../api/auth');

const router = new Router();

router.get('/', renderHome);
router.get('/login', renderLogin);
router.post('/login', processLogin);
router.post('/logout', processLogout);

module.exports = router;
