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
  renderRequestDashboard,
  approveRequest,
  denyRequest
} = require('../api/requests');

const {
  changeActiveApp,
  openDiscoFlix,
  openDiscoFlixSection,
  appUsersPage,
  saveAppUser,
  changeAppSection,
  appFeedPage,
  appLibraryPage,
  appLibraryItem,
  appLookupDetail,
  appLibraryItemAction,
  appSearch,
  appAddMedia,
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
// APP TAKEOVER (PSEUDO-GUILDS)
router.post('/change-active-app/:id', changeActiveApp);
// THE DISCORD BADGE - DISCOFLIX'S OWN TAKEOVER (HEALTH/USERS/SETTINGS)
router.post('/discoflix', openDiscoFlix);
router.post('/discoflix/section/:section', openDiscoFlixSection);
// LITERAL 'add' REGISTERED BEFORE THE :id ROUTES SO IT WINS THE MATCH
router.post('/apps/add/:type', addApp);
router.post('/apps/:id/section/:section', changeAppSection);
router.get('/apps/:id/feed/page/:page', appFeedPage);
router.get('/apps/:id/library/page/:page', appLibraryPage);
router.get('/apps/:id/library/item/:itemId', appLibraryItem);
router.post('/apps/:id/library/item/:itemId/:verb', appLibraryItemAction);
// EPHEMERAL PRE-ADD DETAIL FOR SEARCH RESULTS NOT YET IN THE LIBRARY
router.get('/apps/:id/lookup/:externalKey', appLookupDetail);
router.get('/apps/:id/search', appSearch);
router.get('/apps/:id/users', appUsersPage);
router.post('/apps/:id/users/:userId/save', saveAppUser);
router.post('/apps/:id/add-media', appAddMedia);
router.post('/apps/:id/queue-action/:verb', appQueueAction);
router.post('/apps/:id/save', saveApp);
router.post('/apps/:id/test', testApp);
router.post('/apps/:id/default', setDefaultApp);
router.delete('/apps/:id', removeApp);
// REGISTERED BEFORE THE GENERIC MODAL ROUTE SO THEY WIN THE MATCH
router.get('/modal/apps/picker', renderAppPicker);
router.get('/modal/apps/remove/:id', confirmRemoveApp);
router.get('/modal/requests/dashboard', renderRequestDashboard);
router.post('/requests/:id/approve', approveRequest);
router.post('/requests/:id/deny', denyRequest);
// INFO POPUPS ARE READ-ONLY - NO SAVE/DELETE ROUTES; EDITS LIVE IN THE
// DISCOFLIX AND APP TAKEOVER SURFACES
router.get('/modal/:type/:modal', renderModal);
router.get('/settings/:type/page/:page', getSettingsPage);
router.get('/settings/:type/search', searchSettings);
router.post('/server-sort', changeServerSortOrder);
router.post('/app-sort', changeAppSortOrder);

module.exports = router;
