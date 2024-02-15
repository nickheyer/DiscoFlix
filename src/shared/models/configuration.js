class Configuration {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async get() {
    this.logger.debug('Retrieving configuration from database.');
    const configuration = await this.prisma.configuration.findFirst();
    if (!configuration) {
      this.logger.warn('No configuration found. Creating a new configuration entry.');
      return await this.prisma.configuration.create();
    }
    this.logger.debug('Configuration successfully retrieved.');
    return configuration;
  }

  async update(fields = {}) {
    const configuration = await this.get();
    this.logger.info(`Updating Prisma configuration with fields: ${JSON.stringify(fields)}`);
    return await this.prisma.configuration.update({
      where: { id: configuration.id },
      data: fields
    }).then(updatedConfig => {
      this.logger.info('Prisma configuration updated successfully.');
      return updatedConfig;
    }).catch(error => {
      this.logger.error(`Error updating Prisma configuration: ${error}`);
      throw error;
    });
  }
}

module.exports = Configuration;
