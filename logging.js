const util = require('util');
const path = require('path');
const { LOGS_DIR } = require('./src/core/paths');
const { createLogger, transports } = require('winston');
const Transport = require('winston-transport');
const { default: logWrapper } = require('@epegzz/winston-dev-console');
require('winston-daily-rotate-file');

// WIN ONLY UNDERSTANDS /-ROOTED PATHS
const devConsoleCallee = require('@epegzz/winston-dev-console/dist/getCallee');
devConsoleCallee.getCallee = () => {
  const line = (new Error().stack || '').split('\n')[3] || '';
  const functionNameMatch = line.match(/\w+@|at (([^(]+)) \(.*/) || [];
  const fileMatch = line.match(/((?:[A-Za-z]:)?[/\\][^:]+):(\d+):\d+/) || [];
  return {
    functionName: functionNameMatch[1] || '',
    filePath: fileMatch[1] || '',
    lineNumber: fileMatch[2] || ''
  };
};

const DB_LOG_LEVEL = 'info';
const DB_METADATA_MAX_CHARS = 4000;
// PRUNE CADENCE + RETENTION READ FROM TUNING AT WRITE/PRUNE TIME - LOGGING
// BOOTS BEFORE THE SNAPSHOT PRIMES, WHICH JUST MEANS DEFAULTS SERVE EARLY
const tuning = require('./src/core/tuning');

// WINSTON -> EventLog ROWS. FIRE-AND-FORGET WRITES, PERIODIC SIZE PRUNE, AND
// FAILURES GO TO console SO A DB PROBLEM CAN NEVER LOG-LOOP THROUGH WINSTON
class PrismaTransport extends Transport {
  constructor(getPrisma) {
    super({ level: DB_LOG_LEVEL });
    this.getPrisma = getPrisma;
    this._writes = 0;
    this._warned = false;
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    callback();

    const splat = info[Symbol.for('splat')] || [];
    let metadata = null;
    if (splat.length) {
      try {
        metadata = JSON.stringify(splat.map(item => item instanceof Error ? (item.stack || item.message) : item));
      } catch (err) {
        metadata = util.format(...splat);
      }
      if (metadata.length > DB_METADATA_MAX_CHARS) metadata = metadata.slice(0, DB_METADATA_MAX_CHARS);
    }

    const prisma = this.getPrisma();
    prisma.eventLog.create({
      data: {
        level: info.level,
        message: typeof info.message === 'string' ? info.message : util.format(info.message),
        metadata
      }
    }).then(() => {
      this._warned = false;
      if (++this._writes % tuning.value('log_prune_every_writes') === 0) this._prune(prisma);
    }).catch(err => {
      if (!this._warned) {
        this._warned = true;
        console.error(`EventLog write failed (muting until one succeeds): ${err.message}`);
      }
    });
  }

  async _prune(prisma) {
    try {
      const edge = await prisma.eventLog.findFirst({
        orderBy: { timestamp: 'desc' },
        skip: tuning.value('log_keep_newest'),
        select: { timestamp: true }
      });
      if (edge) await prisma.eventLog.deleteMany({ where: { timestamp: { lte: edge.timestamp } } });
    } catch (err) {
      console.error(`EventLog prune failed: ${err.message}`);
    }
  }
}

function getLogger() {
  const winLogger = createLogger({
    level: 'silly',
    transports: [
      new transports.DailyRotateFile({
        filename: path.join(LOGS_DIR, 'dflog-%DATE%.log'),
        datePattern: 'YYYY-MM-DD-HH',
        zippedArchive: true,
        frequency: '1d',
        maxSize: '20m',
        maxFiles: '14d'
      }),
      new transports.DailyRotateFile({
        level: 'error',
        filename: path.join(LOGS_DIR, 'dferr-%DATE%.log'),
        datePattern: 'YYYY-MM-DD-HH',
        zippedArchive: true,
        frequency: '1d',
        maxSize: '20m',
        maxFiles: '14d'
      }),
    ]
  });
  const logger = logWrapper.init(winLogger);
  logger.add(
    logWrapper.transport({
      showTimestamps: false,
      addLineSeparation: true,
    })
  );

  logger.inspect = (obj) => logger.debug(util.format(obj));

  // WIRED BY CoreService ONCE PRISMA EXISTS - getPrisma STAYS LAZY SO THE
  // CLIENT ISN'T INSTANTIATED JUST BY LOGGING BEFORE FIRST USE
  logger.attachDbTransport = (getPrisma) => {
    if (logger._dbTransportAttached) return;
    logger._dbTransportAttached = true;
    logger.add(new PrismaTransport(getPrisma));
  };

  return logger;
}

module.exports = getLogger;
