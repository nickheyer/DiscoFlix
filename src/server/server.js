const serve = require('koa-static');
const bodyParser = require('koa-bodyparser');
const Pug = require('koa-pug');
const { PUBLIC_DIR, CACHE_DIR } = require('../core/paths');
const { runMigrations } = require('../core/migrate');

(async () => {
  // SCHEMA FIRST - EVERYTHING BELOW ASSUMES THE TABLES EXIST
  await runMigrations();

  const core = require('../core/CoreService');
  const { app, server } = core;
  const errorHandler = require('./middlewares/errorHandler');
  const debugHandler = require('./middlewares/debugHandler');
  const { defermentMiddleware } = require('./middlewares/defermentHandler');
  const { compileMiddleware } = require('./middlewares/compiler');
  const { authHandler } = require('./middlewares/authHandler');
  const { viewSessionHandler } = require('./middlewares/viewSessionHandler');
  const routes = require('./routes');
  new Pug({
    viewPath: `${__dirname}/views`,
    basedir: `${__dirname}/views`,
    app: app
  });

  // Middlewares - Incoming Requests
  app.use(bodyParser());
  app.use(errorHandler());
  app.use(debugHandler());
  app.use(compileMiddleware);
  app.use(defermentMiddleware);
  app.use(serve(PUBLIC_DIR));
  app.use(serve(CACHE_DIR));

  // AUTH SITS AFTER STATIC - LOGIN PAGE ASSETS STAY REACHABLE
  app.use(authHandler());
  // EVERY ROUTE PAST AUTH KNOWS WHICH BROWSER IT SERVES (df_view COOKIE)
  app.use(viewSessionHandler());

  // Routes
  app.use(routes.routes()).use(routes.allowedMethods());

  // Start the server
  const port = process.env.PORT || 4000;
  server.listen(port, () => {
    core.logger.silly(`Server listening on http://0.0.0.0:${port}`);
  });
})().catch((err) => {
  console.error(`DiscoFlix failed to start: ${err.stack || err}`);
  process.exit(1);
});
