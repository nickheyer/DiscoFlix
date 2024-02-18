const _ = require('lodash');

module.exports = (core) => {
  _.mixin(core, require('./websocket'));
  _.mixin(core, require('./server'));
  _.mixin(core, require('./rendering'));
  _.mixin(core, require('./discord'));
}
