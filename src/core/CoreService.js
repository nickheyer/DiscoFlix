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
    this._prisma = null;
    this._app = null;
    this._server = null;
    this._client = null;
    this._wss = null;
    this._connections = new Map();
    this._bindModels();
    this._bindMethods();
    this._bindSockets();
    this._initDiscordClient();
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
    
      // SETTING EVENT HANDLERS FOR ON SHUTDOWN
      process.on('SIGINT', (e) => this.shutdownServer('SIGNINT', e));
      process.on('SIGTERM', (e) => this.shutdownServer('SIGTERM', e,));
      process.on('uncaughtException', (e) => this.uncaughtShutdown('uncaughtException', e));
    }
    return this._server;
  }

  get prisma() {
    if (!this._prisma) {
      this._prisma = new PrismaClient();
    }
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
    return app;
  }
  
  _initDiscordClient() {
    this.logger.info('Initializing Discord Bot');
    const clientInstance = this.client;
    this.autoStartBot();
    return clientInstance;
  }

  _bindModels() {
    require('./models')(this);
  }

  _bindMethods() {
    require('./methods')(this);
  }

  _bindLogging() {
    this.logger = require('../../logging')({ prisma: this.prisma });
    this.logger.silly('Logging Initialized');
  }

  _bindSockets() {
    require('./wsroutes')(this);
  }

}

module.exports = CoreService.instance;