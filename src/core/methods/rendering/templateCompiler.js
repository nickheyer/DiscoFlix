const path = require('path');
const pug = require('pug');
const { renderMarkdownLite } = require('./markdownLite');

// TEMPLATE CACHING SKIPPED OUTSIDE PRODUCTION SO TEMPLATE EDITS SHOW ON REFRESH
const CACHE_TEMPLATES = process.env.NODE_ENV === 'production';

module.exports = {
  async compile(viewFiles, globalArgs = {}, localArgsArray = []) {
    if (!Array.isArray(viewFiles)) {
      viewFiles = [viewFiles];
      localArgsArray = [localArgsArray];
    }

    const renderedViews = await Promise.all(viewFiles.map((file, index) => {
      const viewPath = path.resolve(__dirname, '../../../server/views/components', file);
      // `md` IS AVAILABLE IN EVERY COMPILED TEMPLATE - ESCAPES, THEN RENDERS
      // THE DISCORD-MARKDOWN SUBSET. USE WITH !{md(...)} ONLY.
      const templateArgs = { md: renderMarkdownLite, ...globalArgs, ...(localArgsArray[index] || {}), cache: CACHE_TEMPLATES };
      return pug.renderFile(viewPath, templateArgs);
    }));

    return renderedViews.join('');
  }
}
