const createNamespace = require('../namespace');

module.exports = (core) => {
  const apps = createNamespace(
    core,
    require('./registry'),
    require('./instances'),
    require('./monitor'),
    require('./browse'),
    require('./unifiedLibrary'),
    require('./requestViews'),
    require('./requestActions'),
    require('./envSeed')
  );
  apps.watches = new Map();       // requestId -> watch (CARRIES appId)
  apps._envSeedPromise = null;    // RUN-ONCE LATCH FOR seedFromEnv
  apps._monitorTimer = null;
  apps._heartbeatTimer = null;
  apps.statusCache = new Map();   // appId -> { ok, version|error, checkedAt }
  apps.queueCache = new Map();    // appId -> normalized queue rows
  apps.sessionsCache = new Map(); // appId -> normalized session rows (NOW PLAYING)
  apps.feedCache = new Map();     // appId -> { feed, fetchedAt } (ACTIVITY FEED PAGE 1)
  apps.libraryCache = new Map();  // appId -> { items, fetchedAt } (FULL NORMALIZED LISTING)
  apps.browseViews = new Map();   // `appId:mode` -> 'covers' | 'detailed' (LIBRARY VIEW TOGGLE)
  apps._lastRailKey = null;
  apps._lastTickerKey = null;
  apps.startHeartbeat();
  // DEFERRED + unref'D LIKE THE HEARTBEAT BOOT TICK - ONE-OFF SCRIPTS THAT
  // REQUIRE THE CORE MUST STILL BE ABLE TO EXIT BEFORE IT FIRES
  const rearm = setTimeout(() => {
    apps.rearmWatches().catch(err => apps.logger.warn(`Watch re-arm failed: ${err.message}`));
  }, 2000);
  rearm.unref?.();
  return apps;
};
