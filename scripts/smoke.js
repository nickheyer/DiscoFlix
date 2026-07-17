// CI SMOKE TEST FOR PACKAGED BINARIES: BOOTS THE BINARY AGAINST A THROWAWAY
// DATA DIR ON A SCRUBBED ENVIRONMENT (NO .env, NO TOKENS - NOTHING EXTERNAL
// CAN BE TOUCHED) AND PASSES ONCE THE HTTP CONSOLE ANSWERS. EXERCISES THE
// SNAPSHOT END TO END: PRISMA ENGINE LOAD, BOOT MIGRATIONS, PUG, STATICS.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = process.argv[2];
const PORT = process.env.SMOKE_PORT || '5099';
const TIMEOUT_MS = 90_000;
const POLL_MS = 1500;

if (!BIN || !fs.existsSync(BIN)) {
  console.error(`usage: node scripts/smoke.js <path-to-binary> (got: ${BIN})`);
  process.exit(2);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoflix-smoke-'));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoflix-cwd-'));

const child = spawn(path.resolve(BIN), [], {
  cwd: runDir, // EMPTY CWD SO dotenv FINDS NO .env
  env: {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT || '', // WINDOWS NETWORKING NEEDS THIS
    PORT,
    DF_DATA_DIR: dataDir
  },
  stdio: 'inherit'
});

let exited = false;
child.on('exit', (code, signal) => {
  exited = true;
  if (!done) {
    console.error(`SMOKE FAIL: binary exited early (code=${code} signal=${signal})`);
    process.exit(1);
  }
});

let done = false;
const deadline = Date.now() + TIMEOUT_MS;

async function poll() {
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' });
      console.log(`SMOKE PASS: HTTP ${res.status} from packaged binary`);
      done = true;
      child.kill();
      const db = path.join(dataDir, 'disco.db');
      if (!fs.existsSync(db)) {
        console.error('SMOKE FAIL: server answered but no sqlite db was created in DF_DATA_DIR');
        process.exit(1);
      }
      process.exit(0);
    } catch {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
  if (!exited) {
    console.error(`SMOKE FAIL: no HTTP response on :${PORT} within ${TIMEOUT_MS / 1000}s`);
    child.kill();
  }
  process.exit(1);
}

poll();
