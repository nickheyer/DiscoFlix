const createNamespace = require('../namespace');

module.exports = (core) => {
  const arr = createNamespace(
    core,
    require('./clients'),
    require('./monitor'),
    require('./requestViews')
  );
  arr.watches = new Map();
  arr._monitorTimer = null;
  return arr;
};
