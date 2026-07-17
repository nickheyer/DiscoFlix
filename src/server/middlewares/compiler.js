async function compileMiddleware(ctx, next) {
  ctx.compileView = async (viewFiles, globalArgs = {}, localArgsArray = []) => {
    ctx.body = await ctx.core.render.compile(viewFiles, globalArgs, localArgsArray);
  };
  // FULL-PAGE RENDERS (index/login) - CACHED COMPILE FROM THE VIEWS ROOT
  ctx.renderPage = async (viewFile, args = {}) => {
    ctx.body = await ctx.core.render.compilePage(viewFile, args);
    ctx.type = 'text/html';
  };
  await next();
}

module.exports = {
  compileMiddleware
};
