async function compileMiddleware(ctx, next) {
  ctx.compileView = async (viewFiles, globalArgs = {}, localArgsArray = []) => {
    ctx.body = await ctx.core.render.compile(viewFiles, globalArgs, localArgsArray);
  };
  await next();
}

module.exports = {
  compileMiddleware
};
