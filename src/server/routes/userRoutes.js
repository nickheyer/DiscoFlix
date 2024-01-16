const Router = require('koa-router');
const { createUserHandler, getAllUsersHandler } = require('../api/users');

const router = new Router();

router.post('/users', createUserHandler);
router.get('/users', getAllUsersHandler);

module.exports = router;