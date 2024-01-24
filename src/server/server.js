const Koa = require('koa');
const serve = require('koa-static');
const views = require('koa-views');
const bodyParser = require('koa-bodyparser');
const errorHandler = require('./middlewares/errorHandler');
const debugHandler = require('./middlewares/debugHandler');
const routes = require('./routes');
const socketHandler = require('./sockets/socketHandler');
const http = require('http');
const WebSocket = require('ws');
const Pug = require('koa-pug');

const app = new Koa();
const server = http.createServer(app.callback());
const wss = new WebSocket.Server({ server });
const pug = new Pug({
  viewPath: `${__dirname}/views`,
  basedir: `${__dirname}/views`,
  app: app
});

// Middlewares
app.use(bodyParser());
app.use(errorHandler());
app.use(debugHandler());
app.use(serve(__dirname + '/static'));

// Routes
app.use(routes.routes()).use(routes.allowedMethods());

// Sockets
socketHandler(wss);

// Start the server
const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});
