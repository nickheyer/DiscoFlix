const discord = require('./discord');
const websocket = require('./websocket');
const server = require('./server');
const rendering = require('./rendering');


function bindMethods(methods, cls) {
  for (let [name, method] of Object.entries(methods)) {
    cls[name] = method;
  }
}

module.exports = (core) => {
  bindMethods(discord, core);
  bindMethods(websocket, core);
  bindMethods(server, core);
  bindMethods(rendering, core);
}
