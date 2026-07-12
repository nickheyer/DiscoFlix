const createNamespace = require('../namespace');

module.exports = (core) => {
  const apps = createNamespace(
    core,
    require('./registry'),
    require('./instances'),
    require('./monitor'),
    require('./requestViews')
  );
  apps.watches = new Map();       // requestId -> watch (CARRIES appId)
  apps._monitorTimer = null;
  apps._heartbeatTimer = null;
  apps.statusCache = new Map();   // appId -> { ok, version|error, checkedAt }
  apps.queueCache = new Map();    // appId -> normalized queue rows
  apps._lastRailKey = null;
  apps._lastTickerKey = null;
  apps.startHeartbeat();
  return apps;
};
