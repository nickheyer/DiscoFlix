const Router = require('koa-router');
const {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder,
  changeActiveChannel
} = require('../api/sidebar');

const {
  toggleBotState,
  toggleAppState
} = require('../api/userControls');

const {
  renderModal,
  getSettingsPage,
  searchSettings
} = require('../api/modals');

const {
  appRequestsBody,
  appRequestsPage,
  approveRequest,
  denyRequest,
  jumpToRequestMessage
} = require('../api/requests');

const { fetchChatHistory, uploadChatMedia, jumpToPresent } = require('../api/chat');

const {
  getUserProfile,
  getUserProfileAccess,
  saveUserProfile,
  setUserTier
} = require('../api/userProfile');

const { dismissOnboarding } = require('../api/home');

const {
  appBotMatrix,
  saveBotConfig,
  saveBotFeature,
  resetBotFeature
} = require('../api/botMatrix');

const {
  changeActiveApp,
  openDiscoFlix,
  openDiscoFlixSection,
  appUsersBody,
  appUsersPage,
  appLogsPage,
  saveAppUser,
  changeAppSection,
  appFeedPage,
  appUnifiedLibrary,
  appUnifiedLibraryPage,
  appLibraryItem,
  appLookupDetail,
  appLibraryItemAction,
  appSeasonEpisodes,
  appItemReleases,
  appGrabItemRelease,
  appEditLibraryItem,
  confirmLibraryDelete,
  appDeleteLibraryItem,
  appSearch,
  appAddMedia,
  appImage,
  appQueueAdd,
  appGrabRelease,
  appQueueAction,
  changeAppSortOrder,
  renderAppPicker,
  addApp,
  saveApp,
  testApp,
  setDefaultApp,
  confirmRemoveApp,
  removeApp
} = require('../api/apps');

const router = new Router();

// STATE-CHANGING ROUTES ARE POST-ONLY (M3)
router.post('/toggle-sidebar', toggleSidebarState);
router.post('/toggle-bot', toggleBotState);
router.post('/toggle-power', toggleAppState);
router.post('/change-active-server/:id', changeActiveServers);
router.post('/change-active-channel/:id', changeActiveChannel);
// SCROLL-UP CHAT PAGINATION (READ-ONLY)
router.get('/chat/history/:channelId', fetchChatHistory);
// OG-DISCORD ATTACH - THE + STAGES A FILE, SENT TO THE ACTIVE CHANNEL AS THE BOT
router.post('/chat/upload', uploadChatMedia);
// TIME-TRAVEL EXIT - BACK TO THE LIVE HEAD FROM AN ANCHORED WINDOW
router.post('/chat/jump-to-present', jumpToPresent);
// THE FIRST-RUN CHECKLIST'S PERMANENT DISMISS
router.post('/onboarding/dismiss', dismissOnboarding);
// APP TAKEOVER (PSEUDO-GUILDS)
router.post('/change-active-app/:id', changeActiveApp);
// THE DISCORD BADGE - DISCOFLIX'S OWN TAKEOVER (HEALTH/USERS/SETTINGS)
router.post('/discoflix', openDiscoFlix);
router.post('/discoflix/section/:section', openDiscoFlixSection);
// LITERAL 'add' REGISTERED BEFORE THE :id ROUTES SO IT WINS THE MATCH
router.post('/apps/add/:type', addApp);
router.post('/apps/:id/section/:section', changeAppSection);
router.get('/apps/:id/feed/page/:page', appFeedPage);
// THE DISCORD BOT TAB - MATRIX SCOPE SWAPS AND PER-FEATURE RULE WRITES
// (ALL HANDLERS 404 UNLESS THE INSTANCE IS THE DISCOFLIX SELF APP)
router.get('/apps/:id/bot', appBotMatrix);
router.post('/apps/:id/bot/config', saveBotConfig);
router.post('/apps/:id/bot/feature/:featureId', saveBotFeature);
router.delete('/apps/:id/bot/feature/:featureId', resetBotFeature);
// THE UNIFIED LIBRARY (SELF APP) - FILTER SWAPS AND VIEW MORE PAGINATION
router.get('/apps/:id/unified', appUnifiedLibrary);
router.get('/apps/:id/unified/page/:page', appUnifiedLibraryPage);
router.get('/apps/:id/library/item/:itemId', appLibraryItem);
// DETAIL PHASE 2 - EPISODE TABLES, RELEASE PICKING, EDIT, AND REMOVAL. THE
// NAMED POSTS REGISTER BEFORE THE GENERIC :verb ROUTE SO THEY WIN THE MATCH.
router.get('/apps/:id/library/item/:itemId/season/:season', appSeasonEpisodes);
router.get('/apps/:id/library/item/:itemId/releases', appItemReleases);
router.post('/apps/:id/library/item/:itemId/grab', appGrabItemRelease);
router.post('/apps/:id/library/item/:itemId/edit', appEditLibraryItem);
router.post('/apps/:id/library/item/:itemId/delete', appDeleteLibraryItem);
router.post('/apps/:id/library/item/:itemId/:verb', appLibraryItemAction);
// EPHEMERAL PRE-ADD DETAIL FOR SEARCH RESULTS NOT YET IN THE LIBRARY
router.get('/apps/:id/lookup/:externalKey', appLookupDetail);
router.get('/apps/:id/search', appSearch);
// SERVICE ART PROXY - AUTH STAYS SERVER-SIDE (SEE appImage)
router.get('/apps/:id/image', appImage);
router.get('/apps/:id/users', appUsersBody);
router.get('/apps/:id/users/page/:page', appUsersPage);
// THE REQUESTS SECTION (SELF APP) - FILTER/SEARCH SWAPS AND VIEW MORE
router.get('/apps/:id/requests', appRequestsBody);
router.get('/apps/:id/requests/page/:page', appRequestsPage);
router.get('/apps/:id/logs', appLogsPage);
router.post('/apps/:id/users/:userId/save', saveAppUser);
router.post('/apps/:id/add-media', appAddMedia);
router.post('/apps/:id/queue-action/:verb', appQueueAction);
router.post('/apps/:id/queue-add', appQueueAdd);
router.post('/apps/:id/grab', appGrabRelease);
router.post('/apps/:id/save', saveApp);
router.post('/apps/:id/test', testApp);
router.post('/apps/:id/default', setDefaultApp);
router.delete('/apps/:id', removeApp);
// REGISTERED BEFORE THE GENERIC MODAL ROUTE SO THEY WIN THE MATCH
router.get('/modal/apps/picker', renderAppPicker);
router.get('/modal/apps/remove/:id', confirmRemoveApp);
router.get('/modal/apps/library-delete/:id/:itemId', confirmLibraryDelete);
router.post('/requests/:id/approve', approveRequest);
router.post('/requests/:id/deny', denyRequest);
router.post('/requests/:id/jump', jumpToRequestMessage);
// THE RICH USER PROFILE - EVERY USER CLICK (AVATAR, AUTHOR NAME, MEMBER ROW,
// USER CARD (i), REQUESTER CHIP) LANDS HERE; THE GENERIC /settings POPUP
// KEEPS SERVING OTHER MODEL TYPES
router.get('/user/:id/profile', getUserProfile);
router.get('/user/:id/profile/access', getUserProfileAccess);
router.post('/user/:id/profile/save', saveUserProfile);
router.post('/user/:id/tier', setUserTier);
// INFO POPUPS ARE READ-ONLY - NO SAVE/DELETE ROUTES; EDITS LIVE IN THE
// DISCOFLIX AND APP TAKEOVER SURFACES
router.get('/modal/:type/:modal', renderModal);
router.get('/settings/:type/page/:page', getSettingsPage);
router.get('/settings/:type/search', searchSettings);
router.post('/server-sort', changeServerSortOrder);
router.post('/app-sort', changeAppSortOrder);

module.exports = router;
