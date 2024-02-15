const _ = require('lodash');

class DiscordServer {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async create(data = {}) {
    this.logger.debug('Creating DiscordServer:', data);
    return this.prisma.discordServer.create({ data });
  }

  async upsert(data = {}) {
    const server_id = data.server_id;
    let foundServer = await this.get({ server_id });
    if (!foundServer) {
      const servers = await this.getMany();
      data.sort_position = servers.length;
      foundServer = await this.create(data);
    } else if (!_.isMatch(foundServer, data)) {
      foundServer = await this.update({ server_id }, data);
    }
    return foundServer;
  }

  async get(where = {}) {
    return this.prisma.discordServer.findFirst({ where });
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
