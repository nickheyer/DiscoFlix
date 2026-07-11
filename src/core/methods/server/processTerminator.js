const { createHttpTerminator } = require('http-terminator');

module.exports = {
  async uncaughtShutdown(signal, e) {
    this.logger.error(`Uncaught exception encountered\n...CHECK LOGS.`, signal, e);
    console.trace(signal, e);
  },
  async shutdownServer(signal, e) {
    this.logger.silly(`Received ${signal}\n${e}\n...Shutting down gracefully.`);
    try {
      await createHttpTerminator({ server: this.core.server }).terminate();
    } catch (error) {
      this.logger.error('Failed to terminate server:', error);
    }
    process.exit();
  }
};
