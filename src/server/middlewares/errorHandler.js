function errorHandler() {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      ctx.status = err.response.status || 500;
      ctx.body = { message: err.message };
      ctx.app.emit('error', err, ctx);
    }
  };
}

module.exports = errorHandler;
