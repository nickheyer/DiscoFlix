// THE STANDALONE DATABASE ADMIN AT /admin - ITS OWN PAGE, NOT A SPA
// SECTION. EVERY ROUTE 404s UNLESS Configuration.db_admin_enabled IS ON;
// THE CONSOLE'S AUTH MIDDLEWARE ALREADY RUNS IN FRONT OF ALL OF IT.
//
// SWAP MODEL: /admin RENDERS THE FULL PAGE (views/admin.pug). MODEL
// SWITCHES SWAP #adminBody (RAIL COUNTS + TOOLBAR + GRID); SEARCH/SORT/
// PAGE/FILTER/BULK/SAVE SWAP ONLY #adminGrid SO THE SEARCH BOX NEVER
// LOSES FOCUS MID-TYPE; THE ROW EDITOR LIVES IN THE #adminDrawer RAIL
// (SAVE ERRORS COME BACK VIA HX-Retarget SO THE INPUT SURVIVES).
const dbadmin = require('../../core/dbadmin');

async function buildDbData(core, query = {}) {
  const all = dbadmin.models();
  const modelName = all.some(m => m.name === query.model) ? query.model : all[0].name;
  const [grid, info, counts] = await Promise.all([
    dbadmin.gridPage(core, modelName, query),
    dbadmin.tableInfo(core, modelName),
    Promise.all(all.map(m => core.prisma[m.clientProp].count().catch(() => null)))
  ]);
  return {
    models: all.map((m, i) => ({ name: m.name, count: counts[i] })),
    modelName,
    grid,
    info
  };
}

async function guard(ctx) {
  const config = await ctx.core.models.configuration.get();
  if (!config.db_admin_enabled) {
    ctx.status = 404;
    return false;
  }
  return true;
}

function gridQueryFrom(source) {
  return {
    model: String(source.model || ''),
    search: String(source.search || '').trim(),
    sort: String(source.sort || ''),
    dir: String(source.dir || ''),
    page: source.page,
    filterField: String(source.filterField || ''),
    filterValue: String(source.filterValue || '')
  };
}

// GET /admin - THE FULL STANDALONE PAGE
async function adminPage(ctx) {
  if (!await guard(ctx)) return;
  const db = await buildDbData(ctx.core, gridQueryFrom(ctx.query));
  return ctx.renderPage('admin', { db });
}

// GET /admin/body - MODEL SWITCH (RAIL + TOOLBAR + GRID)
async function adminBody(ctx) {
  if (!await guard(ctx)) return;
  const db = await buildDbData(ctx.core, gridQueryFrom(ctx.query));
  return ctx.compileView('admin/adminBody.pug', { db });
}

// GET /admin/grid - SEARCH/SORT/PAGE/FILTER (GRID PANEL ONLY)
async function adminGrid(ctx) {
  if (!await guard(ctx)) return;
  const db = await buildDbData(ctx.core, gridQueryFrom(ctx.query));
  return ctx.compileView('admin/adminGrid.pug', { db });
}

// GET /admin/editor - ROW EDITOR INTO THE DRAWER (pk ABSENT = NEW ROW)
async function adminEditor(ctx) {
  if (!await guard(ctx)) return;
  try {
    const pk = ctx.query.pk === undefined || ctx.query.pk === '' ? null : String(ctx.query.pk);
    const modelName = String(ctx.query.model || '');
    const editor = await dbadmin.editorRow(ctx.core, modelName, pk);
    return ctx.compileView('admin/adminEditor.pug', {
      editor,
      dbQuery: gridQueryFrom(ctx.query),
      error: null
    });
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: err.message };
  }
}

// POST /admin/row/save - SUCCESS SWAPS THE GRID AND CLOSES THE DRAWER;
// FAILURE RETARGETS THE DRAWER WITH THE OPERATOR'S INPUT INTACT
async function adminSaveRow(ctx) {
  if (!await guard(ctx)) return;
  const body = ctx.request.body || {};
  const modelName = String(body.model || '');
  const pk = body.pk === undefined || body.pk === '' ? null : String(body.pk);
  try {
    const row = await dbadmin.saveRow(ctx.core, modelName, pk, body);
    const model = dbadmin.modelByName(modelName);
    const db = await buildDbData(ctx.core, gridQueryFrom(body));
    return ctx.compileView('admin/adminGrid.pug', {
      db,
      closeDrawer: true,
      message: `${modelName} ${pk ? 'updated' : 'created'} - ${String(row[model.pk])}`
    });
  } catch (err) {
    const model = dbadmin.modelByName(modelName);
    const editor = {
      model,
      pk,
      fields: model.columns.map(col => ({
        col,
        value: String(body[`f_${col.name}`] ?? ''),
        isNull: ['true', 'on', '1'].includes(String(body[`f_${col.name}__null`] ?? '').toLowerCase())
      }))
    };
    ctx.set('HX-Retarget', '#adminDrawer');
    ctx.set('HX-Reswap', 'innerHTML');
    return ctx.compileView('admin/adminEditor.pug', {
      editor,
      dbQuery: gridQueryFrom(body),
      error: err.message
    });
  }
}

// POST /admin/bulk - action=delete|set OVER scope=selected|filtered
async function adminBulk(ctx) {
  if (!await guard(ctx)) return;
  const body = ctx.request.body || {};
  const modelName = String(body.model || '');
  const query = gridQueryFrom(body);
  const ids = [].concat(body.ids || []).map(String).filter(Boolean);
  const filtered = String(body.scope || '') === 'filtered';
  const scope = filtered ? { query } : { ids };

  let message;
  let closeDrawer = false;
  try {
    if (!filtered && !ids.length) {
      message = 'No rows selected';
    } else if (String(body.action) === 'delete') {
      const res = await dbadmin.bulkDelete(ctx.core, modelName, scope);
      message = `Deleted ${res.count} row${res.count === 1 ? '' : 's'}`;
      closeDrawer = true; // A DELETED ROW'S OPEN EDITOR MUST NOT LINGER
    } else if (String(body.action) === 'set') {
      const wantNull = ['true', 'on', '1'].includes(String(body.setnull ?? '').toLowerCase());
      const res = await dbadmin.bulkSet(ctx.core, modelName, scope, String(body.field || ''), body.value, wantNull);
      message = `Updated ${res.count} row${res.count === 1 ? '' : 's'}`;
    } else {
      message = 'Unknown bulk action';
    }
  } catch (err) {
    message = `Bulk action failed: ${err.message}`;
  }
  const db = await buildDbData(ctx.core, query);
  return ctx.compileView('admin/adminGrid.pug', { db, message, closeDrawer });
}

// POST /admin/sql - THE CONSOLE. DELIBERATELY RAW - THAT IS THE FEATURE.
async function adminSql(ctx) {
  if (!await guard(ctx)) return;
  try {
    const result = await dbadmin.runSql(ctx.core, (ctx.request.body || {}).sql);
    return ctx.compileView('admin/adminSqlOut.pug', { result, error: null });
  } catch (err) {
    return ctx.compileView('admin/adminSqlOut.pug', { result: null, error: err.message });
  }
}

// POST /discoflix/db-warning/dismiss - SILENCES THE NO-PASSWORD BUBBLE +
// SETTINGS CARD EVERYWHERE (STICKY)
async function dismissDbWarning(ctx) {
  const core = ctx.core;
  await core.models.configuration.update({ db_admin_warning_dismissed: true });
  core.discord.refreshUI().catch(() => {});
  ctx.body = '';
}

module.exports = {
  adminPage,
  adminBody,
  adminGrid,
  adminEditor,
  adminSaveRow,
  adminBulk,
  adminSql,
  dismissDbWarning
};
