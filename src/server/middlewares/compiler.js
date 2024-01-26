const path = require('path');
const pug = require('pug');

async function compileView(viewFiles, globalArgs = {}, localArgsArray = []) {
  if (!Array.isArray(viewFiles)) {
    viewFiles = [viewFiles];
    localArgsArray = [localArgsArray];
  }

  const renderedViews = await Promise.all(viewFiles.map((file, index) => {
    const viewPath = path.resolve(__dirname, '../views/components', file);
    const templateArgs = { ...globalArgs, ...(localArgsArray[index] || {}) };
    return pug.renderFile(viewPath, templateArgs);
  }));

  return renderedViews.join('');
}

async function compileMiddleware(ctx, next) {
  ctx.compileView = async (viewFiles, globalArgs = {}, localArgsArray = []) => {
    ctx.body = await compileView(viewFiles, globalArgs, localArgsArray);
  };
  await next();
}

module.exports = {
  compileMiddleware,
  compileView
};
