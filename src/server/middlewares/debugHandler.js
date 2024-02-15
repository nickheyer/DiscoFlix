function debugHandler() {
  return async (ctx, next) => {
    try {
      global.logger.info(`${ctx.request.method} REQUEST RECIEVED AT ${ctx.request.url} BY ${ctx.request.header.host}`);
      await next();
    } catch (err) {
      global.logger.error(`Encountered an error: ${err}`);
      console.trace(err);
    }
  };
}

module.exports = debugHandler;
