function debugHandler(verbose = false) {
  return async (ctx, next) => {
    try {
      const currTime = new Date(Date.now()).toLocaleTimeString();
      if (verbose) {
        console.log(currTime, JSON.stringify(ctx, 4, 2));
      } else {
        console.log(`${currTime} || ${ctx.request.method} REQUEST RECIEVED AT ${ctx.request.url} BY ${ctx.request.header.host}`);
      }
      await next();
    } catch (err) {
      console.error(`Encountered an error: ${err}`);
    }
  };
}

module.exports = debugHandler;
