const Koa = require('koa');
const Router = require('koa-router');
const serve = require('koa-static');
const bodyParser = require('koa-bodyparser');

const { createUser, getAllUsers } = require('../shared/models/user');

const app = new Koa();
const router = new Router();

// Middleware
app.use(bodyParser());
app.use(serve(__dirname + '/static'));
app.use(router.routes()).use(router.allowedMethods());

// Routes
router.get('/', ctx => {
  ctx.body = 'Hello from the foundations of what will be DiscoFlix[js]!';
});

router.post('/users', async ctx => {
  try {
    const { name, email } = ctx.request.body;
    const newUser = await createUser(name, email);
    ctx.status = 201;
    ctx.body = newUser;
  } catch (error) {
    ctx.status = 400;
    ctx.body = error.message;
  }
});

router.get('/users', async ctx => {
  try {
    const users = await getAllUsers();
    ctx.status = 200;
    ctx.body = users;
  } catch (error) {
    ctx.status = 500;
    ctx.body = error.message;
  }
});

// App instantiation
const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
