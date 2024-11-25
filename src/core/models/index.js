const prismaMW = require('./middleware.js');
const State = require('./state');
const Configuration = require('./configuration');
const DiscordServer = require('./discordServer');
const DiscordServerChannel = require('./discordChannel');
const DiscordBot = require('./discordBot');
const DiscordMessage = require('./discordMessage');
const User = require('./user');


module.exports = (core) => {
  prismaMW(core);
  core.state = new State(core);
  core.configuration = new Configuration(core);
  core.discordServer = new DiscordServer(core);
  core.discordChannel = new DiscordServerChannel(core);
  core.discordBot = new DiscordBot(core);
  core.discordMessage = new DiscordMessage(core);
  core.user = new User(core);
  core.logger.debug('Models bound:', Object.keys(core));
}