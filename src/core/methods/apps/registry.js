// THE APP-TYPE REGISTRY - PURE MODULE (NO core), SO THE BOT'S COMMAND PARSER
// CAN REQUIRE IT DIRECTLY. THIS + THE MANIFESTS REPLACE THE FIVE TABLES THAT
// USED TO DUPLICATE THE SERVICE↔CONTENT-TYPE BINDING (arr/clients.js SERVICES,
// api/apps.js APP_DEFS, requestFlow CONTENT_TYPES, api/requests CONTENT_SERVICES,
// commands TYPE_ALIASES/SLASH_COMMANDS).
const APP_TYPES = require('./manifests');

// NO 'history' SECTION - RECENT ACTIVITY LIVES IN THE TAKEOVER'S RIGHT RAIL
// (apps/appFeed.pug), VISIBLE FROM EVERY SECTION. NO 'search' SECTION EITHER -
// THE RAIL'S SEARCH BAR DRIVES THE LIBRARY (OR RELEASES) SECTION'S SEARCH MODE.
const SECTION_LABELS = {
  overview: 'Overview',
  requests: 'Requests',
  bot: 'Discord Bot',
  queue: 'Queue',
  sessions: 'Now Playing',
  library: 'Library',
  releases: 'Releases',
  users: 'Users',
  logs: 'Logs',
  chat: 'Chat',
  directives: 'Directives',
  database: 'Database',
  settings: 'Settings'
};

function getType(appType) {
  return APP_TYPES[appType] || null;
}

function allTypes() {
  return Object.values(APP_TYPES);
}

// UNIQUE-BY-TYPE CONTENT DEFS, EACH TAGGED WITH THE APP TYPES PROVIDING IT:
// [{ type, label, slash, aliases, externalIdField, appTypes: ['radarr'] }]
let _contentTypeDefs = null;
function contentTypeDefs() {
  if (!_contentTypeDefs) {
    const defs = new Map();
    for (const manifest of Object.values(APP_TYPES)) {
      for (const contentType of manifest.contentTypes) {
        if (!defs.has(contentType.type)) {
          defs.set(contentType.type, { ...contentType, appTypes: [] });
        }
        defs.get(contentType.type).appTypes.push(manifest.id);
      }
    }
    _contentTypeDefs = [...defs.values()];
  }
  return _contentTypeDefs;
}

// MANIFEST-CONTRIBUTED BOT FEATURES, MERGED BY id LIKE CONTENT TYPES - APP
// TYPES SHARING A DEF (E.G. EVERY MEDIA SERVER) POOL THEIR INSTANCES INTO ONE
// FEATURE. SHARED IDS MUST SHARE ONE DEF OBJECT AND ITS SEMANTICS.
let _interactionDefs = null;
function interactionDefs() {
  if (!_interactionDefs) {
    const defs = new Map();
    for (const manifest of Object.values(APP_TYPES)) {
      for (const def of manifest.interactions || []) {
        if (!defs.has(def.id)) defs.set(def.id, { ...def, appTypes: [] });
        defs.get(def.id).appTypes.push(manifest.id);
      }
    }
    _interactionDefs = [...defs.values()];
  }
  return _interactionDefs;
}

// MANIFEST-DECLARED BOT FEATURES WITH NO INTERACTION DEF OF THEIR OWN, EACH
// TAGGED WITH ITS OWNING APP TYPE. NEVER MERGED ACROSS MANIFESTS - PER-APP
// GRANULARITY IS THE POINT (THE AI PROVIDERS' PER-DOOR ROWS LIVE HERE, ONE
// MATRIX GROUP PER PROVIDER).
let _manifestFeatures = null;
function manifestFeatures() {
  if (!_manifestFeatures) {
    _manifestFeatures = [];
    for (const manifest of Object.values(APP_TYPES)) {
      for (const feature of manifest.botFeatures || []) {
        _manifestFeatures.push({ providers: [manifest.id], ...feature });
      }
    }
  }
  return _manifestFeatures;
}

module.exports = {
  APP_TYPES,
  SECTION_LABELS,
  getType,
  allTypes,
  contentTypeDefs,
  interactionDefs,
  manifestFeatures
};
