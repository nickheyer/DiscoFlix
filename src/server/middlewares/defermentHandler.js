async function defermentMiddleware(ctx, next) {
  ctx.deferToWS = async () => {
    ctx.response.status = 286;
  };
  await next();
}

module.exports = {
  defermentMiddleware
};
