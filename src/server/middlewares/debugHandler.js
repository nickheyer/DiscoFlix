function debugHandler() {
  return async (ctx, next) => {
    try {
      ctx.core.logger.silly(`Request recieved:\nMethod: ${ctx.request.method}\nURL: ${ctx.request.url}\nHost: ${ctx.request.header.host}`);
      await next();
    } catch (err) {
      ctx.core.logger.error(`Encountered an error: ${err}`);
      console.trace(err);
      throw err;
    }
  };
}

module.exports = debugHandler;
