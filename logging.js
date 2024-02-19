function getLogger(opts = {}) {
  const { createLogger, transports } = require('winston');
  const logWrapper = require('@epegzz/winston-dev-console').default;

  const winLogger = createLogger({
    level: 'silly',
    transports: [
      new (transports.File)({
        name: 'info-file',
        filename: `${__dirname}/logs/filelog-info.log`,
        level: 'silly'
      }),

      new (transports.File)({
        name: 'error-file',
        filename: `${__dirname}/logs/filelog-error.log`,
        level: 'error'
      })
    ]
  });
  const logger = logWrapper.init(winLogger);
  logger.add(
    logWrapper.transport({
      showTimestamps: false,
      addLineSeparation: true,
    })
  );
  // logger.add(
  //   new PrismaWinstonTransporter(opts)
  // )

  global.logger = logger;
  return logger;
}

module.exports = getLogger;
