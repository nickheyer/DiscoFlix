const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createServer(data = {}) {
  const server = await prisma.discordServer.create({ data: data });
  return server;
}

async function getServer(where = {}) {
  const server = await prisma.discordServer.findFirst({ where: where });
  return server;
}

async function getServers(where = {}) {
  const servers = await prisma.discordServer.findMany({ where: where });
  return servers;
}

async function updateServer(where = {}, data = {}) {
  const server = await getServer(where);
  if (server) {
    return await prisma.discordServer.update({
      where: { id: server.id },
      data
    })
  }
  return null;
}




module.exports = {
  createServer,
  getServer,
  updateServer,
  getServers
};
