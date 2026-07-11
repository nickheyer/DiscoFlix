const createNamespace = require('../namespace');

module.exports = (core) => createNamespace(
  core,
  require('./processTerminator.js')
);
