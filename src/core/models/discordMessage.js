const _ = require('lodash');

class DiscordMessage {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async create(...args) {
    return this.prisma.discordMessage.create(...args);
  }

  async getOrCreate(data) {
    return await this.upsert(data);
  }

  async upsert(data) {
    return this.prisma.discordMessage.upsert(data);
  }

  async get(where = {}) {
    return this.prisma.discordMessage.findFirst({ where });
  }

  async getMany(where = {}) {
    return this.prisma.discordMessage.findMany({ where });
  }

  async update(where = {}, data = {}) {
    this.logger.info('Updating DiscordMessage:', where);
    return this.prisma.discordMessage.update({ where, data });
  }

  async delete(where = {}) {
    this.logger.warn('Deleting DiscordMessage:', where);
    return this.prisma.discordMessage.delete({ where });
  }

  async deleteMany(...args) {
    return this.prisma.discordMessage.deleteMany(...args);
  }
}

module.exports = DiscordMessage;
