const serverBarRendering = require('./serverBarRendering');
const templateCompiler = require('./templateCompiler');

module.exports = {
  ...serverBarRendering,
  ...templateCompiler,
}
