module.exports = {
  async uncaughtShutdown(signal, e) {
    this.logger.error(`Uncaught exception encountered\n...CHECK LOGS.`, signal, e);
    console.trace(signal, e);
  },
  async shutdownServer(signal, e) {
    // SECOND SIGNAL FORCES AN IMMEDIATE EXIT INSTEAD OF STACKING TERMINATIONS
    if (this._shuttingDown) {
      process.exit(1);
    }
    this._shuttingDown = true;
    this.logger.silly(`Received ${signal}\n${e}\n...Shutting down gracefully.`);
    try {
      // CLOSE THE WSS BEFORE TERMINATING CLIENTS - HTMX AUTO-RECONNECTS THE INSTANT
      // ITS SOCKET DROPS, AND A RECONNECT THAT LANDS MID-SHUTDOWN LEAVES AN UPGRADED
      // SOCKET THE HTTP TERMINATOR WAITS ON FOREVER
      this.core.wss.close();
      for (const socket of this.core.wss.clients) {
        socket.terminate();
      }
      // HTTP-TERMINATOR DOESNT TRACK UPGRADED SOCKETS, SO NEVER TRUST IT TO RESOLVE
      await Promise.race([
        this.core.httpTerminator.terminate(),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    } catch (error) {
      this.logger.error('Failed to terminate server:', error);
    }
    process.exit();
  }
};
