// THE APP TAKEOVER SURFACE (nzb360-STYLE PSEUDO-GUILDS): CLICKING A RAIL
// BUBBLE SWAPS THE WHOLE CONSOLE TO THE APP'S SECTIONS (QUEUE/LIBRARY/...)
// USING THE SAME SLOT-SWAP FRAGMENTS THE SETTINGS SIDEBAR ALREADY PROVED.
const _ = require('lodash');

// RAIL VIEW MODEL — EVERY INSTALLED INSTANCE RENDERS A BUBBLE
async function buildAppRail(core, state = null) {
  return core.apps.getRailViewModel(state);
}

// ── TAKEOVER VIEW MODELS ─────────────────────────────────────────────────

// PER-SECTION PAYLOAD. RENDERS NEVER BLOCK ON LIVE HTTP EXCEPT: OVERVIEW'S
// HEALTH LIST (ONE GUARDED CALL) AND A FIRST-EVER STATUS CHECK WHEN THE
// HEARTBEAT HASN'T RUN YET.
async function buildSectionData(core, instance, section) {
  const client = core.apps.getClientForInstance(instance);
  const configured = !!client;
  const data = { configured, appUrl: configured ? client.baseUrl : null };

  switch (section) {
    case 'overview': {
      if (!configured) {
        data.status = { ok: false, error: `${instance.display_name} is not configured` };
        data.health = [];
        data.queueCount = 0;
        break;
      }
      data.status = core.apps.statusCache.get(instance.id)
        || await core.apps.testInstance(instance);
      data.health = [];
      if (data.status.ok && client.capabilities.health) {
        try {
          data.health = (await client.getHealth()).map(item => ({
            type: item.type || 'warning',
            message: item.message || String(item)
          }));
        } catch (err) {
          core.logger.warn(`${instance.display_name} health fetch failed: ${err.message}`);
        }
      }
      data.queueCount = (core.apps.queueCache.get(instance.id) || []).length;
      break;
    }
    case 'queue': {
      data.queue = core.apps.queueCache.get(instance.id) || [];
      break;
    }
    case 'settings': {
      const manifest = core.apps.getType(instance.app_type);
      // METADATA DESCRIPTORS (SENSITIVE isSet, TYPES) OVERLAID WITH THE
      // MANIFEST'S PER-TYPE LABELS/PLACEHOLDERS — ONE SHAPE FOR THE +field MIXIN
      const formData = core.models.app.getFormData(instance);
      data.formFields = [
        { key: 'display_name', ...formData.display_name },
        { key: 'enabled', ...formData.enabled },
        ...manifest.configFields.map(field => ({
          key: field.key,
          ...formData[field.key],
          label: field.label,
          description: field.description || formData[field.key].description,
          required: field.required,
          placeholder: field.placeholder
        }))
      ];
      // MAKE-DEFAULT ONLY MEANS SOMETHING FOR CONTENT MANAGERS WITH RIVALS
      data.showDefault = false;
      if (manifest.contentTypes.length) {
        const peerCount = await core.prisma.app.count({
          where: { app_type: { in: core.apps.peerAppTypes(instance.app_type) } }
        });
        data.showDefault = peerCount > 1;
      }
      data.contentTypeLabels = manifest.contentTypes.map(ct => ct.label);
      break;
    }
    default:
      break;
  }
  return data;
}

// SECTION-NAV LOCALS - SIDEBAR TOGGLES USE THIS
function buildSectionNav(core, instance) {
  const manifest = core.apps.getType(instance.app_type);
  const section = manifest.sections.includes(instance.active_section)
    ? instance.active_section
    : 'overview';
  return {
    activeApp: instance,
    appManifest: manifest,
    appSections: manifest.sections.map(key => ({
      key,
      label: core.apps.SECTION_LABELS[key] || key
    })),
    section,
    sectionLabel: core.apps.SECTION_LABELS[section] || section
  };
}

async function buildTakeoverLocals(core, instance) {
  const nav = buildSectionNav(core, instance);
  const sectionData = await buildSectionData(core, instance, nav.section);
  return {
    ...nav,
    sectionData,
    // queueBody.pug READS `queue` DIRECTLY SO WS PUSHES AND HTTP RENDERS SHARE ONE SHAPE
    queue: sectionData.queue || []
  };
}

// THE FULL TAKEOVER FRAGMENT SET — THE APP-SIDE ANALOG OF changeActiveServers
async function respondWithTakeover(ctx, instance, state) {
  const core = ctx.core;
  const [servers, discordBot, apps, takeover] = await Promise.all([
    core.render.getServerTemplateObj(null, state),
    core.models.discordBot.get(),
    core.apps.getRailViewModel(state),
    buildTakeoverLocals(core, instance)
  ]);

  return ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug',
    'sidebar/servers/appRail.pug',
    'sidebar/servers/serverBannerContainer.pug',
    'sidebar/userControls/settingsButton.pug',
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'chat/chatBar.pug',
    'members/membersLayout.pug',
    'chat/downloadTicker.pug'
  ], {
    servers,
    discordBot,
    state,
    apps,
    members: [],
    ticker: core.apps.buildTickerAggregate(),
    ...takeover
  });
}

// MIRROR RESTORE — THE SAME FRAGMENT SET changeActiveServers SENDS, MINUS THE
// SERVER SWITCH. THE RESPONSE TO REMOVING THE ACTIVE APP: ITS TAKEOVER ENDS
// BY DEFINITION, SO THE CONSOLE FALLS BACK TO WHATEVER GUILD WAS ACTIVE.
async function respondWithMirror(ctx, state) {
  const core = ctx.core;
  const [msgObjects, servers, discordBot, members, apps] = await Promise.all([
    core.discord.updateMessages(null, state),
    core.render.getServerTemplateObj(null, state),
    core.models.discordBot.get(),
    core.render.getServerMembers(state.active_server_id),
    core.apps.getRailViewModel(state)
  ]);

  const messages = await core.discord.compileMessages(msgObjects);
  const eomStamp = _.get(_.last(msgObjects), 'created_at');

  return ctx.compileView([
    'sidebar/servers/serverSortableContainer.pug',
    'sidebar/servers/appRail.pug',
    'sidebar/servers/serverBannerContainer.pug',
    'sidebar/userControls/settingsButton.pug',
    'sidebar/channels/channelsLayout.pug',
    'chat/messageChannelHeader.pug',
    'chat/chatBar.pug',
    'chat/messageContainer.pug',
    'members/membersLayout.pug'
  ], { servers, discordBot, messages, eomStamp, state, members, apps });
}

// ── HANDLERS ─────────────────────────────────────────────────────────────

async function changeActiveApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const state = await core.models.state.update({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

// SECTION NAV. WHEN THE TARGET INSTANCE ISN'T THE ACTIVE APP THIS ALSO ENTERS
// ITS TAKEOVER — ONE ROUTE POWERS SECTION ROWS, SEARCH INSTANCE TABS, AND THE
// DOWNLOAD TICKER'S JUMP-TO-QUEUE.
async function changeAppSection(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }

  const manifest = core.apps.getType(instance.app_type);
  const section = manifest.sections.includes(ctx.params.section)
    ? ctx.params.section
    : 'overview';
  await core.models.app.update({ id: instance.id }, { active_section: section });
  instance.active_section = section;

  let state = await core.models.state.get();
  if (state.active_app_id !== instance.id) {
    state = await core.models.state.update({ active_app_id: instance.id });
    return respondWithTakeover(ctx, instance, state);
  }

  const takeover = await buildTakeoverLocals(core, instance);
  return ctx.compileView([
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug'
  ], { state, ...takeover });
}

// RAIL DRAG-SORT — THE APP-SIDE changeServerSortOrder. RESPONSE RE-RENDERS
// THE SELF-OOB RAIL SO THE DOM ORDER AND sort_position AGREE
async function changeAppSortOrder(ctx) {
  await ctx.core.models.app.reorder(ctx.request.body.item);
  const apps = await ctx.core.apps.getRailViewModel();
  return ctx.compileView(['sidebar/servers/appRail.pug'], { apps });
}

// ── ADD / SETTINGS / REMOVE FLOWS ────────────────────────────────────────

// "ADD AN APP" PICKER — ONE CARD PER MANIFEST TYPE; TYPES STAY ADDABLE
// FOREVER (MULTI-INSTANCE), THE BADGE JUST SAYS HOW MANY YOU ALREADY RUN
async function renderAppPicker(ctx) {
  const rows = await ctx.core.models.app.getInstalled();
  const counts = {};
  rows.forEach(row => { counts[row.app_type] = (counts[row.app_type] || 0) + 1; });

  const appTypes = ctx.core.apps.allTypes().map(manifest => ({
    id: manifest.id,
    label: manifest.label,
    icon: manifest.icon,
    blurb: manifest.blurb,
    kind: manifest.kind,
    installed: counts[manifest.id] || 0
  }));
  return ctx.compileView('modals/apps/picker.pug', { appTypes });
}

// PICKER CARD CLICK: CREATE THE ROW AND DROP STRAIGHT INTO ITS TAKEOVER ON
// SETTINGS — CONFIG-FIRST LANDING
async function addApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.installType(ctx.params.type);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  core.apps.syncSlashCommands().catch(() => {});
  const state = await core.models.state.update({ active_app_id: instance.id });
  return respondWithTakeover(ctx, instance, state);
}

async function saveApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }

  let updated;
  try {
    updated = await core.apps.saveInstanceConfig(instance, ctx.request.body);
  } catch (err) {
    core.logger.error('APP SAVE FAILED:', err);
    ctx.status = 400;
    ctx.body = { error: err.message };
    return;
  }
  core.apps.syncSlashCommands().catch(() => {});

  // SAVE IS THE ONE MOMENT THE OPERATOR EXPECTS A LIVE ANSWER — REFRESH THE
  // STATUS CACHE NOW SO THE RAIL DOT AND TOAST TELL THE TRUTH IMMEDIATELY
  let message = 'Changes Saved';
  if (updated.enabled && core.apps.isConfigured(updated)) {
    const status = await core.apps.testInstance(updated);
    message = status.ok ? `Connected — v${status.version}` : 'Saved — but unreachable';
  }

  const state = await core.models.state.get();
  const [apps, takeover] = await Promise.all([
    core.apps.getRailViewModel(state),
    buildTakeoverLocals(core, updated)
  ]);
  // NOTIFICATION LAST: THE SURFACE SWAP REPLACES #notification-container, SO
  // THE TOAST HAS TO LAND AFTER THE FRESH ONE EXISTS
  return ctx.compileView([
    'sidebar/servers/appRail.pug',
    'sidebar/servers/serverBannerLabel.pug',
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'extra/notification.pug'
  ], { state, apps, message, ...takeover });
}

// EXPLICIT LIVE CHECK AGAINST THE *SAVED* ROW — PROVES KEEP-ON-BLANK/CLEAR
// ACTUALLY PERSISTED WHAT YOU THINK. RESPONSE = INLINE PILL + RAIL DOT OOB
async function testApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const status = await core.apps.testInstance(instance);
  const apps = await core.apps.getRailViewModel();
  return ctx.compileView([
    'apps/sections/settingsTestResult.pug',
    'sidebar/servers/appRail.pug'
  ], { status, apps });
}

async function setDefaultApp(ctx) {
  const core = ctx.core;
  let instance;
  try {
    instance = await core.apps.setDefaultInstance(ctx.params.id);
  } catch (err) {
    ctx.status = 404;
    return;
  }

  const state = await core.models.state.get();
  const takeover = await buildTakeoverLocals(core, instance);
  return ctx.compileView([
    'apps/appChannelsLayout.pug',
    'apps/appHeader.pug',
    'apps/appSurface.pug',
    'extra/notification.pug'
  ], { state, message: `${instance.display_name} is now the default`, ...takeover });
}

async function confirmRemoveApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  const manifest = core.apps.getType(instance.app_type);
  const requestCount = await core.prisma.mediaRequest.count({
    where: { appId: instance.id }
  });
  return ctx.compileView('modals/apps/confirmRemove.pug', {
    app: instance,
    typeLabel: manifest?.label || instance.app_type,
    requestCount
  });
}

async function removeApp(ctx) {
  const core = ctx.core;
  const instance = await core.apps.getInstance(ctx.params.id);
  if (!instance) {
    ctx.status = 404;
    return;
  }
  await core.apps.removeInstance(instance.id);
  core.apps.syncSlashCommands().catch(() => {});

  // THE FK ALREADY SetNull'D active_app_id; THE EXPLICIT UPDATE JUST GETS US
  // A FRESH state ROW AND COVERS REMOVING A NON-ACTIVE APP THE SAME WAY
  const state = await core.models.state.update({ active_app_id: null });
  return respondWithMirror(ctx, state);
}

module.exports = {
  buildAppRail,
  buildSectionNav,
  buildTakeoverLocals,
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
};
