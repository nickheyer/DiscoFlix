const _ = require('lodash');

class DiscordServerChannel {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async create(data = {}) {
    this.logger.debug('Creating DiscordServerChannel:', data);
    return this.prisma.discordServerChannel.create({ data });
  }

  async upsert(data = {}) {
    const channel_id = data.channel_id;
    let foundChannel = await this.get({ channel_id });
    if (!foundChannel) {
      foundChannel = await this.create(data);
    } else if (!_.isMatch(foundChannel, data)) {
      foundChannel = await this.update({ channel_id }, data);
    }
    return foundChannel;
  }

  async get(where = {}) {
    return this.prisma.discordServerChannel.findFirst({ where });
  }

  async getMany(where = {}) {
    return this.prisma.discordServerChannel.findMany({ where });
  }

  async update(where = {}, data = {}) {
    this.logger.info('Updating DiscordServerChannel:', where);
    return this.prisma.discordServerChannel.update({ where, data });
  }

  async delete(where = {}) {
    this.logger.warn('Deleting DiscordServerChannel:', where);
    return this.prisma.discordServerChannel.delete({ where });
  }

  async deleteMany(where = {}) {
    return this.prisma.discordServerChannel.deleteMany({ where });
  }
}

module.exports = DiscordServerChannel;
