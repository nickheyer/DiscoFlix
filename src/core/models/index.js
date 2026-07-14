const MODELS = {
  state: require('./state'),
  viewSession: require('./viewSession'),
  configuration: require('./configuration'),
  discordServer: require('./discordServer'),
  discordChannel: require('./discordChannel'),
  discordBot: require('./discordBot'),
  discordMessage: require('./discordMessage'),
  user: require('./user'),
  media: require('./media'),
  mediaRequest: require('./mediaRequest'),
  app: require('./app')
};

// MODEL REGISTRY, EXPOSED AS core.models. KEYS DOUBLE AS THE URL-ADDRESSABLE
// MODEL NAMES FOR THE DYNAMIC SETTINGS MODALS (SEE src/server/api/modals.js).
module.exports = (core) => {
  const models = {};

  try {
    // INIT MODELS
    for (const [key, Model] of Object.entries(MODELS)) {
      models[key] = new Model(core);
      core.logger.debug(`Initialized model: ${key}`);
    }

    // LOG INIT STATE
    const boundModels = Object.keys(models);
    core.logger.info('Models initialization complete', {
      count: boundModels.length,
      models: boundModels
    });

    // VERIFY INIT
    const requiredModels = ['state', 'configuration', 'user'];
    for (const model of requiredModels) {
      if (!models[model]) {
        throw new Error(`Critical model not initialized: ${model}`);
      }
    }
  } catch (error) {
    core.logger.error('Failed to initialize models:', error);
    throw error;
  }

  return models;
};
