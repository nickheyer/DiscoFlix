const createNamespace = require('../namespace');

module.exports = (core) => createNamespace(
  core,
  require('./templateCompiler'),
  require('./serverBarRendering')
);
