const { Client } = require('discord.js');
const intentManager = require('./managers/intentManager');
const eventManager = require('./managers/eventManager');

function generateClient(core) {
    const client = new Client(intentManager());
    client.core = core;
    eventManager(client);
    return client;
}

module.exports = generateClient;