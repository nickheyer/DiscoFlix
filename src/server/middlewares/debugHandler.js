function debugHandler() {
  return async (ctx, next) => {
    try {
      global.logger.silly(`Request recieved:\nMethod: ${ctx.request.method}\nURL: ${ctx.request.url}\nHost: ${ctx.request.header.host}`);
      await next();
    } catch (err) {
      global.logger.error(`Encountered an error: ${err}`);
      console.trace(err);
    }
  };
}

module.exports = debugHandler;
