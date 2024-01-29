const _ = require('lodash');

const { Prisma, PrismaClient } = require('@prisma/client');
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

async function getServersSorted(where = {}) {
  const servers = await prisma.discordServer.findMany({
    where: where,
    orderBy: { sort_position: 'asc' }
  });
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

async function reorderServers(newSortPositions) {
  const updateQueries = [];
  for (let i = 0; i < newSortPositions.length; i++) {
    const serverId = newSortPositions[i];
    const updateQuery = prisma.discordServer.update({
        where: { id: parseInt(serverId) },
        data: { sort_position: i }
    });
    updateQueries.push(updateQuery);
  }

  return await prisma.$transaction(updateQueries);
}


module.exports = {
  createServer,
  getServer,
  updateServer,
  getServers,
  reorderServers,
  getServersSorted
};
