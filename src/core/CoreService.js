require('dotenv').config()
const Koa = require('koa');
const { PrismaClient } = require('@prisma/client');
const http = require('http');
const WebSocket = require('ws');

/**
 * Application spine. A singleton that everything hangs off of:
 *
 * - `core.models.*`  — Prisma-backed model wrappers (src/core/models). Keys are
 *                      URL-addressable by the dynamic settings modals.
 * - `core.discord.*` — bot lifecycle + guild/channel/message sync (src/core/methods/discord)
 * - `core.render.*`  — pug compilation + view-model builders (src/core/methods/rendering)
 * - `core.sockets.*` — browser websocket registry + broadcasting (src/core/methods/websocket)
 * - `core.system.*`  — process/server shutdown (src/core/methods/server)
 *
 * Lazy getters: `client` (discord.js), `app` (koa), `server` (http), `prisma`, `wss`.
 */
class CoreService {
  static _instance;

  constructor() {
    if (CoreService._instance) {
      return CoreService._instance;
    }
    CoreService._instance = this;
    this._prisma = null;
    this._app = null;
    this._server = null;
    this._client = null;
    this._wss = null;

    this.logger = require('../../logging')();
    this.models = require('./models')(this);
    this.render = require('./methods/rendering')(this);
    this.sockets = require('./methods/websocket')(this);
    this.discord = require('./methods/discord')(this);
    this.system = require('./methods/server')(this);
    require('./wsroutes')(this);
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

  // DISCARDS THE CURRENT DISCORD CLIENT SO THE NEXT `core.client` REBUILDS IT
  resetClient() {
    this._client = null;
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
      process.on('SIGINT', (e) => this.system.shutdownServer('SIGINT', e));
      process.on('SIGTERM', (e) => this.system.shutdownServer('SIGTERM', e));
      process.on('uncaughtException', (e) => this.system.uncaughtShutdown('uncaughtException', e));
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
    this.discord.autoStartBot();
    return clientInstance;
  }
}

module.exports = CoreService.instance;
