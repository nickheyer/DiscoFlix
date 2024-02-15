const { app, server, logger } = require('../shared/CoreService');
const serve = require('koa-static');
const views = require('koa-views');
const bodyParser = require('koa-bodyparser');
const errorHandler = require('./middlewares/errorHandler');
const debugHandler = require('./middlewares/debugHandler');
const { defermentMiddleware } = require('./middlewares/defermentHandler');
const { compileMiddleware } = require('./middlewares/compiler');
const routes = require('./routes');
const Pug = require('koa-pug');
const pug = new Pug({
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
app.use(serve(__dirname + '/static'));

// Routes
app.use(routes.routes()).use(routes.allowedMethods());



// Start the server
const port = process.env.PORT || 4000;
server.listen(port, () => {
  global.logger.silly(`Server listening on http://0.0.0.0:${port}`);
});
