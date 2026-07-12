// PER-APP DASHBOARD MODALS — v1 OF THE nzb360-STYLE PSEUDO-GUILD SURFACE.
// THE RAIL BUBBLES (sidebar/servers/appRail.pug) LINK HERE.

const APP_DEFS = {
  radarr: { id: 'radarr', label: 'Radarr', icon: '/images/radarr.min.svg', urlField: 'radarr_url', tokenField: 'radarr_token', enabledField: 'is_radarr_enabled' },
  sonarr: { id: 'sonarr', label: 'Sonarr', icon: '/images/sonarr.min.svg', urlField: 'sonarr_url', tokenField: 'sonarr_token', enabledField: 'is_sonarr_enabled' }
};

// RAIL VIEW MODEL — EVERY KNOWN APP RENDERS A BUBBLE; UNCONFIGURED ONES GET
// NO STATUS DOT AND THE MODAL EXPLAINS HOW TO CONNECT THEM
function buildAppRail(config) {
  return Object.values(APP_DEFS).map(app => ({
    id: app.id,
    label: app.label,
    icon: app.icon,
    configured: !!(config[app.urlField] && config[app.tokenField]),
    enabled: !!config[app.enabledField]
  }));
}

function queueViewRow(record) {
  const size = record.size || 0;
  const sizeleft = record.sizeleft || 0;
  const percent = size
    ? Math.max(0, Math.min(100, Math.round(((size - sizeleft) / size) * 100)))
    : 0;
  return {
    title: record.title || 'Unknown',
    status: record.status || 'queued',
    percent,
    timeleft: record.timeleft || null
  };
}

async function renderAppDashboard(ctx) {
  const appDef = APP_DEFS[ctx.params.app];
  if (!appDef) {
    ctx.status = 404;
    return;
  }

  const core = ctx.core;
  const config = await core.models.configuration.get();
  const client = core.arr.getClientFor(appDef.id, config);
  const configured = !!client;

  let status = { ok: false, error: `${appDef.label} is not configured` };
  let queue = [];
  let health = [];

  if (configured) {
    status = await core.arr.testConnection(appDef.id);
    if (status.ok) {
      try {
        queue = (await client.getQueue()).map(queueViewRow);
      } catch (err) {
        core.logger.warn(`${appDef.label} queue fetch failed: ${err.message}`);
      }
      try {
        health = (await client.getHealth()).map(item => ({
          type: item.type || 'warning',
          message: item.message || String(item)
        }));
      } catch (err) {
        core.logger.warn(`${appDef.label} health fetch failed: ${err.message}`);
      }
    }
  }

  return ctx.compileView('modals/apps/appDashboard.pug', {
    app: appDef,
    configured,
    appUrl: configured ? client.baseUrl : null,
    status,
    queue,
    health
  });
}

module.exports = {
  buildAppRail,
  renderAppDashboard
};
