const path = require('path');
const pug = require('pug');

module.exports = {
  async compile(viewFiles, globalArgs = {}, localArgsArray = []) {
    if (!Array.isArray(viewFiles)) {
      viewFiles = [viewFiles];
      localArgsArray = [localArgsArray];
    }
  
    const renderedViews = await Promise.all(viewFiles.map((file, index) => {
      const viewPath = path.resolve(__dirname, '../../../server/views/components', file);
      const templateArgs = { ...globalArgs, ...(localArgsArray[index] || {}) };
      return pug.renderFile(viewPath, templateArgs);
    }));
  
    return renderedViews.join('');
  }
}
