class User {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async get() {
    const user = await this.prisma.user.findFirst();
    if (!user) {
      return await this.prisma.user.create();
    }
    return user;
  }

  async getAll() {
    const users = await this.prisma.user.findMany();
    return users;
  }

  async create(data = {}) {
    const user = await this.prisma.user.create({ data });
    return user;
  }

  async update(fields = {}) {
    this.logger.info('UPDATING PRISMA USER: ', fields);
    return await this.prisma.user.update({
      where: { id: 1 },
      data: fields
    });
  }
}

module.exports = User;
