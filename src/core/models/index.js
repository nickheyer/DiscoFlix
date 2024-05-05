const State = require('./state');
const Configuration = require('./configuration');
const DiscordServer = require('./discordServer');
const DiscordServerChannel = require('./discordChannel');
const DiscordBot = require('./discordBot');
const User = require('./user');


module.exports = (core) => {
  core.state = new State(core);
  core.configuration = new Configuration(core);
  core.discordServer = new DiscordServer(core);
  core.discordChannel = new DiscordServerChannel(core);
  core.discordBot = new DiscordBot(core);
  core.user = new User(core);
  core.logger.debug('Models bound:', Object.keys(core));
}