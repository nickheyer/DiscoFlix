const botMethods = require('./botMethods');
const botController = require('./botController');

module.exports = {
  ...botMethods,
  ...botController,
}
