require('dotenv').config()
const Koa = require('koa');
const { PrismaClient } = require('@prisma/client');
const http = require('http');
const WebSocket = require('ws');

class CoreService {
  static _instance;

  constructor() {
    if (CoreService._instance) {
      return CoreService._instance;
    }
    CoreService._instance = this;
    this._bindLogging();
    this._prisma = new PrismaClient();
    this._app = null;
    this._server = null;
    this._client = null;
    this._wss = null;
    this._connections = new Map();
    this._bindModels();
    this._bindMethods();
    this._bindSockets();
    this.shutdownServer = this.generateTerminator()
  }

  static get instance() {
    if (!CoreService._instance) {
      CoreService._instance = new CoreService();
    }
    return CoreService._instance;
  }

  get client() {
    if (!this._client) {
      this.logger.info('Attaching DiscordJS to core-service');
      this._client = require('./bot/bot')(this);
    }
    return this._client;
  }
  
  get app() {
    if (!this._app) {
      this.logger.info('Attaching Koa to core-service');
      this._app = this._createKoaApp();
    }
    return this._app;
  }

  get server() {
    if (!this._server) {
      this.logger.info('Attaching Http Server to core-service');
      this._server = http.createServer(this.app.callback());
    }
    return this._server;
  }

  get prisma() {
    return this._prisma;
  }

  get wss() {
    if (!this._wss) {
      this.logger.info('Attaching WSS to core-service');
      this._wss = new WebSocket.Server({ server: this.server });
    }
    return this._wss;
  }

  get connections() {
    return this._connections;
  }
  
  _createKoaApp() {
    const app = new Koa();
    app.use(async (ctx, next) => {
      ctx.core = this;
      await next();
    });
    this.autoStartBot();
    return app;
  }

  _bindModels() {
    require('./models')(this);
  }

  _bindMethods() {
    require('./methods')(this);
  }

  _bindLogging() {
    const { createLogger } = require('winston');
    const logWrapper = require('@epegzz/winston-dev-console').default;

    const winLogger = createLogger({
      level: 'silly',
    });
    this.logger = logWrapper.init(winLogger);
    this.logger.add(
      logWrapper.transport({
        showTimestamps: false,
        addLineSeparation: true,
      })
    );

    global.logger = this.logger;
    this.logger.silly('Logging Initialized');
  }

  _bindSockets() {
    require('./wsroutes')(this);
  }

}

module.exports = CoreService.instance;