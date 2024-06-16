const _ = require('lodash');

class DiscordServerChannel {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async create(...args) {
    return this.prisma.discordServerChannel.create(...args);
  }

  async getOrCreate(data) {
    const ch = this.get(data);
    if (!ch) {
      return await this.create({ data });
    }
    return ch;
  }

  async upsert(...args) {
    return this.prisma.discordServerChannel.upsert(...args);
  }

  async get(where = {}) {
    return this.prisma.discordServerChannel.findFirst({ where });
  }

  async getMany(where = {}) {
    return this.prisma.discordServerChannel.findMany({ where });
  }

  async getMessages(channelId) {
    return this.prisma.discordMessage.findMany({
      where: { channel_id: channelId },
      include: {
        user: true,  // INCLUDE USER DETAILS
      }
    });
  }

  async update(where = {}, data = {}) {
    this.logger.info('Updating DiscordServerChannel:', where);
    return this.prisma.discordServerChannel.update({ where, data });
  }

  async delete(where = {}) {
    this.logger.warn('Deleting DiscordServerChannel:', where);
    return this.prisma.discordServerChannel.delete({ where });
  }

  async deleteMany(...args) {
    return this.prisma.discordServerChannel.deleteMany(...args);
  }
}

module.exports = DiscordServerChannel;
