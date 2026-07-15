const fs = require('fs');
const path = require('path');

// SINGLE SOURCE OF TRUTH FOR EVERY FILESYSTEM PATH THE APP TOUCHES AT RUNTIME
const ROOT = path.join(__dirname, '..', '..');
const IS_PACKAGED = Boolean(process.pkg);

const DATA_DIR = process.env.DF_DATA_DIR
  ? path.resolve(process.env.DF_DATA_DIR)
  : (IS_PACKAGED ? path.resolve(process.cwd(), 'discoflix-data') : ROOT);

const USES_DATA_DIR = DATA_DIR !== ROOT;

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const CACHE_DIR = path.join(DATA_DIR, '.cache');
const DB_FILE = USES_DATA_DIR
  ? path.join(DATA_DIR, 'disco.db')
  : path.join(ROOT, 'prisma', 'disco.db');

// PRISMA WANTS FORWARD SLASHES EVEN ON WINDOWS
const DATABASE_URL = `file:${DB_FILE.split(path.sep).join('/')}`;

for (const dir of [DATA_DIR, LOGS_DIR, CACHE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  ROOT,
  IS_PACKAGED,
  DATA_DIR,
  PUBLIC_DIR,
  MIGRATIONS_DIR,
  LOGS_DIR,
  CACHE_DIR,
  DB_FILE,
  DATABASE_URL
};
