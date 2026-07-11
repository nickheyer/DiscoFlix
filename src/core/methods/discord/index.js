const _ = require('lodash');
const createNamespace = require('../namespace');

// afterAuth METHODS TALK TO THE DISCORD API AND ARE ONLY CALLABLE ONCE THE
// CLIENT HAS LOGGED IN — OTHERWISE THEY WARN AND NO-OP.
function requireClientLogin(methods) {
  return _.mapValues(methods, (method, name) => {
    return function (...args) {
      if (this.core.client && this.core.client.isReady()) {
        return method.apply(this, args);
      }
      this.logger.warn(`Discord method '${name}' called before client login`);
      return {};
    };
  });
}

module.exports = (core) => createNamespace(
  core,
  require('./methods'),
  require('./controller'),
  requireClientLogin(require('./afterAuth'))
);
