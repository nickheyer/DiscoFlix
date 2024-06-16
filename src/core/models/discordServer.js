const _ = require('lodash');

class DiscordServer {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async create(...args) {
    return this.prisma.discordServer.create(...args);
  }

  async getOrCreate(data) {
    const srv = this.get(data);
    if (!srv) {
      return await this.create({ data });
    }
    return srv;
  }

  async upsert(...args) {
    return this.prisma.discordServer.upsert(...args);
  }

  async get(where = {}, include = {}) {
    return this.prisma.discordServer.findFirst({ where, include });
  }

  async getMany(where = {}) {
    return this.prisma.discordServer.findMany({ where });
  }

  async getSorted(where = {}) {
    this.logger.info('Getting sorted DiscordServers');
    return this.prisma.discordServer.findMany({
      where,
      orderBy: { sort_position: 'asc' }
    });
  }

  async update(where = {}, data = {}) {
    return this.prisma.discordServer.update({ where, data });
  }

  async reorder(newSortPositions = []) {
    const updateQueries = newSortPositions.map((server_id, index) => 
      this.prisma.discordServer.update({
        where: { server_id },
        data: { sort_position: index }
      })
    );
    return this.prisma.$transaction(updateQueries);
  }

  async deleteMany(where = {}) {
    return this.prisma.discordServer.deleteMany({ where });
  }
}

module.exports = DiscordServer;
