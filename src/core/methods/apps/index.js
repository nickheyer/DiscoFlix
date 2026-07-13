const createNamespace = require('../namespace');

module.exports = (core) => {
  const apps = createNamespace(
    core,
    require('./registry'),
    require('./instances'),
    require('./monitor'),
    require('./browse'),
    require('./requestViews'),
    require('./envSeed')
  );
  apps.watches = new Map();       // requestId -> watch (CARRIES appId)
  apps._envSeedPromise = null;    // RUN-ONCE LATCH FOR seedFromEnv
  apps._monitorTimer = null;
  apps._heartbeatTimer = null;
  apps.statusCache = new Map();   // appId -> { ok, version|error, checkedAt }
  apps.queueCache = new Map();    // appId -> normalized queue rows
  apps.feedCache = new Map();     // appId -> { feed, fetchedAt } (ACTIVITY FEED PAGE 1)
  apps.libraryCache = new Map();  // appId -> { items, fetchedAt } (FULL NORMALIZED LISTING)
  apps.browseViews = new Map();   // `appId:mode` -> 'covers' | 'detailed' (LIBRARY VIEW TOGGLE)
  apps._lastRailKey = null;
  apps._lastTickerKey = null;
  apps.startHeartbeat();
  return apps;
};
