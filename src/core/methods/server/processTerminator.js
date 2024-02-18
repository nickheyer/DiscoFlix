const { createHttpTerminator } = require('http-terminator');
const logger = global.logger;


module.exports = {
  async uncaughtShutdown(signal, e) {
    logger.error(`Uncaught exception encountered\n...CHECK LOGS.`, signal, e);
    console.trace(signal, e);
  },
  async shutdownServer(signal, e) {
    logger.silly(`Received ${signal}\n${e}\n...Shutting down gracefully.`);
    try {
      const serverTerminator = createHttpTerminator({ server: this.server }).terminate();
    } catch (error) {
      logger.error('Failed to terminate server:', error);
    }
    process.exit();
  }
};