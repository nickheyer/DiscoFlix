class DiscordBot {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async get() {
    const discordBot = await this.prisma.discordBot.findFirst();
    if (!discordBot) {
      return await this.prisma.discordBot.create();
    }
    return discordBot;
  }

  async update(fields = {}) {
    const discordBot = await this.get();
    this.logger.debug('Updating Prisma Discord Bot: ', fields);
    return await this.prisma.discordBot.update({
      where: { id: discordBot.id },
      data: fields
    })
  }
}

module.exports = DiscordBot;
