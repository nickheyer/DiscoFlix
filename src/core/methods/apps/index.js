const createNamespace = require('../namespace');

module.exports = (core) => {
  const apps = createNamespace(
    core,
    require('./registry'),
    require('./instances'),
    require('./monitor'),
    require('./browse'),
    require('./requestViews')
  );
  apps.watches = new Map();       // requestId -> watch (CARRIES appId)
  apps._monitorTimer = null;
  apps._heartbeatTimer = null;
  apps.statusCache = new Map();   // appId -> { ok, version|error, checkedAt }
  apps.queueCache = new Map();    // appId -> normalized queue rows
  apps.feedCache = new Map();     // appId -> { feed, fetchedAt } (ACTIVITY FEED PAGE 1)
  apps.libraryCache = new Map();  // appId -> { items, fetchedAt } (FULL NORMALIZED LISTING)
  apps._lastRailKey = null;
  apps._lastTickerKey = null;
  apps.startHeartbeat();
  return apps;
};
