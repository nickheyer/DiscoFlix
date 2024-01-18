const Koa = require('koa');
const serve = require('koa-static');
const views = require('koa-views');
const bodyParser = require('koa-bodyparser');
const errorHandler = require('./middlewares/errorHandler');
const routes = require('./routes');
const socketHandler = require('./sockets/socketHandler');
const http = require('http');
const WebSocket = require('ws');

const app = new Koa();
const server = http.createServer(app.callback());
const wss = new WebSocket.Server({ server });

// Middlewares
app.use(bodyParser());
app.use(errorHandler());
app.use(serve(__dirname + '/static'));
app.use(views(__dirname + '/views', { extension: 'ejs' }));

// Routes
app.use(routes.routes()).use(routes.allowedMethods());

// Sockets
socketHandler(wss);

// Start the server
const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
