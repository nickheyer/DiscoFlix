const util = require('util');
const { createLogger, transports } = require('winston');
const { default: logWrapper } = require('@epegzz/winston-dev-console');
require('winston-daily-rotate-file');

function getLogger(opts = {}) {
  const winLogger = createLogger({
    level: 'silly',
    transports: [
      new transports.DailyRotateFile({
        filename: `${__dirname}/logs/dflog-%DATE%.log`,
        datePattern: 'YYYY-MM-DD-HH',
        zippedArchive: true,
        frequency: '1d',
        maxSize: '20m',
        maxFiles: '14d'
      }),
      new transports.DailyRotateFile({
        level: 'error',
        filename: `${__dirname}/logs/dferr-%DATE%.log`,
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

  global.logger = logger;
  return logger;
}

module.exports = getLogger;
