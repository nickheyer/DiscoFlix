// THE APP-TYPE REGISTRY — PURE MODULE (NO core), SO THE BOT'S COMMAND PARSER
// CAN REQUIRE IT DIRECTLY. THIS + THE MANIFESTS REPLACE THE FIVE TABLES THAT
// USED TO DUPLICATE THE SERVICE↔CONTENT-TYPE BINDING (arr/clients.js SERVICES,
// api/apps.js APP_DEFS, requestFlow CONTENT_TYPES, api/requests CONTENT_SERVICES,
// commands TYPE_ALIASES/SLASH_COMMANDS).
const APP_TYPES = require('./manifests');

// NO 'history' SECTION — RECENT ACTIVITY LIVES IN THE TAKEOVER'S RIGHT RAIL
// (apps/appFeed.pug), VISIBLE FROM EVERY SECTION
const SECTION_LABELS = {
  overview: 'Overview',
  queue: 'Queue',
  library: 'Library',
  search: 'Search & Add',
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

// { movie: 'movie', film: 'movie', tv: 'show', ... } — PREFIX KEYWORD LOOKUP
let _aliasIndex = null;
function aliasIndex() {
  if (!_aliasIndex) {
    _aliasIndex = {};
    for (const def of contentTypeDefs()) {
      for (const alias of def.aliases || []) {
        _aliasIndex[alias.toLowerCase()] = def.type;
      }
    }
  }
  return _aliasIndex;
}

// { movie: { contentType: 'movie' }, show: { contentType: 'show' } }
let _slashDefs = null;
function slashDefs() {
  if (!_slashDefs) {
    _slashDefs = {};
    for (const def of contentTypeDefs()) {
      if (def.slash?.name) {
        _slashDefs[def.slash.name] = { contentType: def.type };
      }
    }
  }
  return _slashDefs;
}

module.exports = {
  APP_TYPES,
  SECTION_LABELS,
  getType,
  allTypes,
  contentTypeDefs,
  aliasIndex,
  slashDefs
};
