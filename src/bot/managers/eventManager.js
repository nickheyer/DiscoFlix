const eventRoutes = require('./events');


module.exports = (client) => {
  for (const eventName in eventRoutes) {
    const event = eventRoutes[eventName];
    if (event.once) {
      client.once(event.name, async (...args) => await event.execute(...args));
    } else {
      client.on(event.name, async (...args) => await event.execute(...args));
    }
  }
};
