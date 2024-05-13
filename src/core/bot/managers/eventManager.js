const eventRoutes = require('./events');


module.exports = (client) => {
  for (const eventName in eventRoutes) {
    const event = eventRoutes[eventName];
    if (event.onMultiple && event.onMultiple.length > 0) {
      for (const singleEvent of event.onMultiple) {
        client.on(singleEvent, async (...args) => await event.execute(client, ...args));
      }
    } else if (event.once) {
      client.once(event.name, async (...args) => await event.execute(...args));
    } else {
      client.on(event.name, async (...args) => await event.execute(...args));
    }
  }
};
