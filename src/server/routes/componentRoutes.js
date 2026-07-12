const Router = require('koa-router');
const {
  toggleSidebarState,
  changeActiveServers,
  changeServerSortOrder,
  changeActiveChannel,
  toggleSettings
} = require('../api/sidebar');

const {
  toggleBotState,
  toggleAppState
} = require('../api/userControls');

const {
  renderModal,
  getSettingsPage,
  saveSettings,
  searchSettings,
  deleteRecord
} = require('../api/modals');

const {
  renderRequestDashboard,
  approveRequest,
  denyRequest
} = require('../api/requests');

const {
  changeActiveApp,
  changeAppSection,
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
router.post('/toggle-settings/:action', toggleSettings);
router.post('/change-active-server/:id', changeActiveServers);
router.post('/change-active-channel/:id', changeActiveChannel);
// APP TAKEOVER (PSEUDO-GUILDS)
router.post('/change-active-app/:id', changeActiveApp);
// LITERAL 'add' REGISTERED BEFORE THE :id ROUTES SO IT WINS THE MATCH
router.post('/apps/add/:type', addApp);
router.post('/apps/:id/section/:section', changeAppSection);
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
router.get('/modal/:type/:modal', renderModal);
router.get('/settings/:type/page/:page', getSettingsPage);
router.post('/settings/:type/save{/:id}', saveSettings);
router.get('/settings/:type/search', searchSettings);
router.delete('/settings/:type/delete/:id', deleteRecord);
router.post('/server-sort', changeServerSortOrder);
router.post('/app-sort', changeAppSortOrder);

module.exports = router;
