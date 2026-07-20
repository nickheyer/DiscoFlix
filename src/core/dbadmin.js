// THE BUILT-IN DATABASE ADMIN - MODEL-AGNOSTIC BY CONSTRUCTION. EVERYTHING
// HERE DERIVES FROM Prisma.dmmf.datamodel AT RUNTIME (FIELDS, TYPES, PKS,
// RELATIONS, UNIQUES), SO NEW MODELS AND COLUMNS SHOW UP WITH ZERO WIRING.
// SQLITE-LEVEL TRUTH (INDEXES, FK PRAGMAS) RIDES ALONG VIA PRAGMA QUERIES.
//
// SECURITY MODEL: EVERY ROUTE THAT REACHES THIS MODULE IS (a) BEHIND THE
// CONSOLE'S AUTH MIDDLEWARE AND (b) GATED ON Configuration.db_admin_enabled.
// MODEL/FIELD NAMES FROM THE WIRE ARE VALIDATED AGAINST THE REGISTRY BELOW -
// THE ONLY DELIBERATELY RAW SURFACE IS THE SQL CONSOLE, WHICH IS THE POINT.

const { Prisma } = require('@prisma/client');
const tuning = require('./tuning');

const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);

// ── MODEL REGISTRY (STATIC PER PROCESS - DMMF NEVER CHANGES AT RUNTIME) ──
let _models = null;

function models() {
  if (_models) return _models;
  const dm = Prisma.dmmf.datamodel;
  const byName = new Map(dm.models.map(m => [m.name, m]));

  _models = dm.models.map(model => {
    const idField = model.fields.find(f => f.isId);
    const scalars = model.fields.filter(f => f.kind === 'scalar' || f.kind === 'enum');
    const relations = model.fields.filter(f => f.kind === 'object');

    // FK COLUMN -> WHICH MODEL/FIELD IT POINTS AT (FOR GRID JUMP LINKS)
    const fkOf = {};
    for (const rel of relations) {
      if (!rel.isList && (rel.relationFromFields || []).length === 1) {
        fkOf[rel.relationFromFields[0]] = {
          model: rel.type,
          field: rel.relationToFields[0]
        };
      }
    }

    // HAS-MANY BACKLINKS: CHILD MODEL + ITS FK FIELD, FILTERED BY OUR PK.
    // IMPLICIT M2M (NO FK ON EITHER SIDE) HAS NO CHEAP JUMP - SKIPPED.
    const backlinks = relations
      .filter(rel => rel.isList)
      .map(rel => {
        const other = byName.get(rel.type);
        const paired = other?.fields.find(f =>
          f.kind === 'object' && f.relationName === rel.relationName && (f.relationFromFields || []).length === 1);
        return paired ? { label: rel.name, model: rel.type, field: paired.relationFromFields[0] } : null;
      })
      .filter(Boolean);

    const columns = scalars.map(f => ({
      name: f.name,
      type: f.type,
      isId: !!f.isId,
      required: !!f.isRequired,
      hasDefault: !!f.hasDefaultValue,
      // PKS ARE IDENTITY, @updatedAt IS PRISMA-STAMPED, Bytes HAS NO SANE
      // TEXT EDITOR - EVERYTHING ELSE IS FAIR GAME
      readonly: !!f.isId || !!f.isUpdatedAt || f.type === 'Bytes',
      fk: fkOf[f.name] || null
    }));

    return {
      name: model.name,
      clientProp: lowerFirst(model.name),
      dbName: model.dbName || model.name,
      pk: idField ? idField.name : null,
      columns,
      backlinks,
      uniques: [
        ...model.uniqueFields.map(group => group.join(' + ')),
        ...(idField ? [] : [])
      ],
      searchables: scalars.filter(f => f.type === 'String').map(f => f.name),
      sortDefault: scalars.some(f => f.name === 'created_at')
        ? { field: 'created_at', dir: 'desc' }
        : { field: idField ? idField.name : scalars[0].name, dir: 'asc' }
    };
  })
    // NO SINGLE PK = NO ROW ADDRESSING - EVERY CURRENT MODEL HAS ONE, BUT
    // STAY HONEST IF A COMPOSITE-KEY MODEL EVER LANDS
    .filter(model => model.pk);
  return _models;
}

function modelByName(name) {
  const model = models().find(m => m.name === name);
  if (!model) throw new Error(`Unknown model: ${name}`);
  return model;
}

function columnOf(model, fieldName) {
  const col = model.columns.find(c => c.name === fieldName);
  if (!col) throw new Error(`Unknown field ${fieldName} on ${model.name}`);
  return col;
}

function delegate(core, model) {
  const client = core.prisma[model.clientProp];
  if (!client) throw new Error(`No client delegate for ${model.name}`);
  return client;
}

// ── VALUE COERCION (WIRE STRING -> PRISMA VALUE) ─────────────────────────
function coerce(col, raw, wantNull) {
  if (wantNull) {
    if (col.required) throw new Error(`${col.name} is required and cannot be null`);
    return null;
  }
  if (raw === undefined) return undefined; // NOT POSTED - LEAVE UNCHANGED
  const str = String(raw);
  if (str === '') {
    if (col.type === 'String') return col.required ? '' : '';
    if (!col.required) return null;
    if (col.hasDefault) return undefined; // LET THE DEFAULT FILL IT
    throw new Error(`${col.name} is required`);
  }
  switch (col.type) {
    case 'Int': case 'BigInt': {
      const n = parseInt(str, 10);
      if (!Number.isFinite(n)) throw new Error(`${col.name}: not an integer`);
      return n;
    }
    case 'Float': case 'Decimal': {
      const n = parseFloat(str);
      if (!Number.isFinite(n)) throw new Error(`${col.name}: not a number`);
      return n;
    }
    case 'Boolean':
      return ['true', 'on', '1', 'yes'].includes(str.toLowerCase());
    case 'DateTime': {
      const d = new Date(str);
      if (isNaN(d.getTime())) throw new Error(`${col.name}: not a valid date`);
      return d;
    }
    default:
      return str;
  }
}

// ── DISPLAY SERIALIZATION (PRISMA VALUE -> CELL) ─────────────────────────
const CELL_TRUNCATE = 120;

function cellOf(col, value) {
  if (value === null || value === undefined) return { text: 'null', isNull: true };
  if (col.type === 'DateTime') return { text: new Date(value).toISOString().replace('T', ' ').slice(0, 19) };
  if (col.type === 'Boolean') return { text: value ? 'true' : 'false', bool: value };
  const str = typeof value === 'bigint' ? value.toString() : String(value);
  if (str.length > CELL_TRUNCATE) return { text: str.slice(0, CELL_TRUNCATE) + '…', full: str };
  return { text: str };
}

// RAW EDITOR VALUE - WHAT GOES INSIDE THE INPUT
function editValueOf(col, value) {
  if (value === null || value === undefined) return '';
  if (col.type === 'DateTime') return new Date(value).toISOString();
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

// ── QUERYING ─────────────────────────────────────────────────────────────
function whereFrom(model, { search, filterField, filterValue }) {
  const where = {};
  if (filterField) {
    const col = columnOf(model, filterField);
    where[col.name] = filterValue === 'null' ? null : coerce(col, filterValue, false);
  }
  if (search && model.searchables.length) {
    where.OR = model.searchables.map(f => ({ [f]: { contains: search } }));
  }
  return where;
}

function orderFrom(model, sort, dir) {
  const field = sort && model.columns.some(c => c.name === sort) ? sort : model.sortDefault.field;
  const direction = dir === 'asc' || dir === 'desc' ? dir : model.sortDefault.dir;
  return { field, direction };
}

async function gridPage(core, modelName, query = {}) {
  const model = modelByName(modelName);
  const pageSize = tuning.value('db_admin_page_size');
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const where = whereFrom(model, query);
  const order = orderFrom(model, query.sort, query.dir);

  const [total, rows] = await Promise.all([
    delegate(core, model).count({ where }),
    delegate(core, model).findMany({
      where,
      orderBy: { [order.field]: order.direction },
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);

  return {
    model,
    query: {
      search: query.search || '',
      filterField: query.filterField || '',
      filterValue: query.filterValue || '',
      sort: order.field,
      dir: order.direction,
      page
    },
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map(row => ({
      pk: String(row[model.pk]),
      cells: model.columns.map(col => ({
        col,
        ...cellOf(col, row[col.name]),
        // FK JUMP CARRIES THE RAW VALUE - null FKS DON'T LINK
        jump: col.fk && row[col.name] != null
          ? { model: col.fk.model, field: col.fk.field, value: String(row[col.name]) }
          : null
      }))
    }))
  };
}

async function editorRow(core, modelName, pk = null) {
  const model = modelByName(modelName);
  const row = pk === null
    ? null
    : await delegate(core, model).findUnique({ where: { [model.pk]: pk } });
  if (pk !== null && !row) throw new Error(`${model.name} row not found`);
  return {
    model,
    pk,
    fields: model.columns.map(col => ({
      col,
      value: row ? editValueOf(col, row[col.name]) : '',
      isNull: row ? row[col.name] === null : !col.required && !col.hasDefault
    }))
  };
}

async function saveRow(core, modelName, pk, body) {
  const model = modelByName(modelName);
  const data = {};
  for (const col of model.columns) {
    if (col.readonly && !(pk === null && col.isId)) continue;
    // CREATE MAY SUPPLY AN EXPLICIT ID; BLANK LETS THE DEFAULT MINT ONE
    const raw = body[`f_${col.name}`];
    const wantNull = ['true', 'on', '1'].includes(String(body[`f_${col.name}__null`] ?? '').toLowerCase());
    const value = coerce(col, raw, wantNull);
    if (value !== undefined) data[col.name] = value;
    if (pk === null && col.isId && (raw === undefined || raw === '')) delete data[col.name];
  }
  if (pk === null) return delegate(core, model).create({ data });
  return delegate(core, model).update({ where: { [model.pk]: pk }, data });
}

// scope: { ids: [...] } OR { query: <grid query> } - BULK OPS WORK ON THE
// CHECKED ROWS OR ON EVERYTHING THE CURRENT FILTER MATCHES
function scopeWhere(model, scope) {
  if (scope.ids) return { [model.pk]: { in: scope.ids } };
  return whereFrom(model, scope.query || {});
}

async function bulkDelete(core, modelName, scope) {
  const model = modelByName(modelName);
  return delegate(core, model).deleteMany({ where: scopeWhere(model, scope) });
}

async function bulkSet(core, modelName, scope, fieldName, rawValue, wantNull) {
  const model = modelByName(modelName);
  const col = columnOf(model, fieldName);
  if (col.readonly) throw new Error(`${col.name} is read-only`);
  const value = coerce(col, rawValue ?? '', wantNull);
  if (value === undefined) throw new Error('No value given');
  return delegate(core, model).updateMany({
    where: scopeWhere(model, scope),
    data: { [col.name]: value }
  });
}

async function countScope(core, modelName, scope) {
  const model = modelByName(modelName);
  return delegate(core, model).count({ where: scopeWhere(model, scope) });
}

// ── SQL CONSOLE ──────────────────────────────────────────────────────────
const READ_SQL = /^\s*(select|pragma|explain|with)\b/i;

async function runSql(core, sql) {
  const text = String(sql || '').trim();
  if (!text) return { kind: 'empty' };
  if (READ_SQL.test(text)) {
    const cap = tuning.value('db_admin_sql_row_cap');
    const rows = await core.prisma.$queryRawUnsafe(text);
    const list = Array.isArray(rows) ? rows : [rows];
    const shown = list.slice(0, cap).map(row => {
      const out = {};
      for (const [key, val] of Object.entries(row)) {
        out[key] = val === null ? null : typeof val === 'bigint' ? val.toString() : val instanceof Date ? val.toISOString() : String(val);
      }
      return out;
    });
    return {
      kind: 'rows',
      columns: shown.length ? Object.keys(shown[0]) : [],
      rows: shown,
      total: list.length,
      truncated: list.length > shown.length
    };
  }
  const affected = await core.prisma.$executeRawUnsafe(text);
  return { kind: 'write', affected };
}

// ── SQLITE-LEVEL INFO (INDEXES + FKS) FOR THE MODEL INFO PANEL ───────────
async function tableInfo(core, modelName) {
  const model = modelByName(modelName);
  const quoted = `"${model.dbName.replace(/"/g, '""')}"`;
  const [indexes, fks] = await Promise.all([
    core.prisma.$queryRawUnsafe(`PRAGMA index_list(${quoted})`).catch(() => []),
    core.prisma.$queryRawUnsafe(`PRAGMA foreign_key_list(${quoted})`).catch(() => [])
  ]);
  return {
    indexes: (indexes || []).map(ix => ({ name: String(ix.name), unique: !!Number(ix.unique) })),
    foreignKeys: (fks || []).map(fk => ({
      from: String(fk.from), table: String(fk.table), to: String(fk.to), onDelete: String(fk.on_delete)
    }))
  };
}

module.exports = {
  models,
  modelByName,
  gridPage,
  editorRow,
  saveRow,
  bulkDelete,
  bulkSet,
  countScope,
  runSql,
  tableInfo
};
