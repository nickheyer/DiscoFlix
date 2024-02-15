const { Client } = require('discord.js');
const intentManager = require('./managers/intentManager');
const eventManager = require('./managers/eventManager');

function generateClient(coreService) {
    const client = new Client(intentManager());
    client.core = coreService;
    eventManager(client);
    return client;
}

module.exports = generateClient;