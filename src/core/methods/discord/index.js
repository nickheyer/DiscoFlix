const _ = require('lodash');


function rejectInvocation(method) {
  this.logger.warn('CALLING CLIENT METHODS BEFORE LOGIN');
  console.trace(method);
  return {};
}

function requireClientLogin(modulePath) {
  const moduleObj = require(modulePath);
  return _.mapValues(moduleObj, (method) => {
    return function(...args) {
      if (this.client && this.client.isReady()) {
        return method.apply(this, args);
      } else {
        return rejectInvocation(method);
      }
    };
  });
}

module.exports = {
  ...require('./methods'),
  ...require('./controller'),
  ...requireClientLogin('./afterAuth')
};
