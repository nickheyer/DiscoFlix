const pug = require('pug');
const path = require('path');


async function compileView(viewFile, templateArgs = {}) {
  const viewPath = path.resolve(__dirname, '../../server/views/components', viewFile);
  return pug.renderFile(viewPath, templateArgs);
}

module.exports = {
  compileView
};
