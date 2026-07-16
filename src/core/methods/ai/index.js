const createNamespace = require('../namespace');

// core.ai - THE AI PROVIDER SERVICE: TOOL SURFACE + AGENT LOOP + TURN
// RUNNERS. PROVIDER CLIENTS LIVE WITH THE OTHER APP CLIENTS (core.apps
// BUILDS THEM); THIS NAMESPACE IS EVERYTHING ABOVE THE WIRE.
module.exports = (core) => {
  const ai = createNamespace(
    core,
    require('./tools'),
    require('./service')
  );
  ai._threadLocks = new Map(); // conversationId -> in-flight turn promise
  return ai;
};
