const createNamespace = require('../namespace');

module.exports = (core) => {
  const sockets = createNamespace(core, require('./connections'));
  sockets.connections = new Map();
  return sockets;
};
