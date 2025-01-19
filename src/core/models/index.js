const prismaMW = require('./middleware.js');

const MODELS = {
  state: require('./state'),
  configuration: require('./configuration'),
  discordServer: require('./discordServer'),
  discordChannel: require('./discordChannel'),
  discordBot: require('./discordBot'),
  discordMessage: require('./discordMessage'),
  user: require('./user'),
  media: require('./media'),
  mediaRequest: require('./mediaRequest')
};

module.exports = (core) => {
  try {
    // INIT MW
    prismaMW(core);
    core.logger.info('Prisma middleware initialized');

    // INIT MODELS
    for (const [key, Model] of Object.entries(MODELS)) {
      core[key] = new Model(core);
      core.logger.debug(`Initialized model: ${key}`);
    }

    // LOG INIT STATE
    const boundModels = Object.keys(MODELS);
    core.logger.info('Models initialization complete', {
      count: boundModels.length,
      models: boundModels
    });

    // VERIFY INIT
    const requiredModels = ['state', 'configuration', 'user'];
    for (const model of requiredModels) {
      if (!core[model]) {
        throw new Error(`Critical model not initialized: ${model}`);
      }
    }

  } catch (error) {
    core.logger.error('Failed to initialize models:', error);
    throw error;
  }
};