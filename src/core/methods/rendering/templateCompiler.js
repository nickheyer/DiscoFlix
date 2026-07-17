const path = require('path');
const fs = require('fs');
const pug = require('pug');
const { renderMarkdownLite } = require('./markdownLite');

const VIEWS_DIR = path.resolve(__dirname, '../../../server/views');
const COMPONENTS_DIR = path.join(VIEWS_DIR, 'components');

// COMPILED TEMPLATES CACHE FOREVER
const CACHE_FOREVER = process.env.NODE_ENV === 'production';
const REVALIDATE_INTERVAL_MS = 1000;

const compiledTemplates = new Map();

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function isStale(entry) {
  return entry.files.some((file) => mtimeOf(file.path) !== file.mtimeMs);
}

function compiledTemplateFor(absPath) {
  const now = Date.now();
  const cached = compiledTemplates.get(absPath);
  if (cached) {
    if (CACHE_FOREVER || now - cached.checkedAt < REVALIDATE_INTERVAL_MS) return cached.fn;
    if (!isStale(cached)) {
      cached.checkedAt = now;
      return cached.fn;
    }
  }

  const fn = pug.compileFile(absPath, {
    basedir: VIEWS_DIR,
    compileDebug: !CACHE_FOREVER
  });
  const files = [absPath, ...(fn.dependencies || [])]
    .map((file) => ({ path: file, mtimeMs: mtimeOf(file) }));
  compiledTemplates.set(absPath, { fn, files, checkedAt: now });
  return fn;
}

module.exports = {
  async compile(viewFiles, globalArgs = {}, localArgsArray = []) {
    if (!Array.isArray(viewFiles)) {
      viewFiles = [viewFiles];
      localArgsArray = [localArgsArray];
    }

    return viewFiles.map((file, index) => {
      const fn = compiledTemplateFor(path.resolve(COMPONENTS_DIR, file));
      // `md` IS AVAILABLE IN EVERY COMPILED TEMPLATE - ESCAPES, THEN RENDERS
      // THE DISCORD-MARKDOWN SUBSET. USE WITH !{md(...)} ONLY.
      return fn({ md: renderMarkdownLite, ...globalArgs, ...(localArgsArray[index] || {}) });
    }).join('');
  },

  // FULL PAGES (index/login) RESOLVE FROM THE VIEWS ROOT AND RIDE THE SAME CACHE
  async compilePage(viewFile, args = {}) {
    if (!path.extname(viewFile)) viewFile += '.pug';
    const fn = compiledTemplateFor(path.resolve(VIEWS_DIR, viewFile));
    return fn({ md: renderMarkdownLite, ...args });
  }
};
