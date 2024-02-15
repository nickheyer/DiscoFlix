const { createHttpTerminator } = require('http-terminator');

module.exports = {
  generateTerminator() {
    const serverTerminator = createHttpTerminator({ server: this.server })
    const logger = this.logger;
  
    async function cleanup() {
      logger.info('IN CLEANUP');
      try {
        await serverTerminator.terminate();
      } catch (error) {
        logger.error('Failed to terminate server:', error);
      }
    }
  
    async function uncaught(signal, e) {
      logger.error(`Uncaught exception encountered\n...CHECK LOGS.`, signal, e);
      console.trace(signal, e);
    }
  
    async function shutdownServer(signal, e) {
      logger.silly(`Received ${signal}\n${e}\n...Shutting down gracefully.`);
      await cleanup();
      process.exit();
    }
  
    // SETTING EVENT HANDLERS FOR ON SHUTDOWN
    process.on('SIGINT', (e) => shutdownServer('SIGNINT', e));
    process.on('SIGTERM', (e) => shutdownServer('SIGTERM', e));
    process.on('uncaughtException', (e) => uncaught('uncaughtException', e));
  
    return shutdownServer;
  }
};