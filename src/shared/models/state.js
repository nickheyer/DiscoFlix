const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();


async function getState() {
  const state = await prisma.state.findFirst();
  if (!state) {
    return await prisma.state.create();
  }
  return state;
}

async function updateState(fields = {}) {
  const state = await getState();
  return await prisma.state.update({
    where: { id: state.id },
    data: fields
  })
}

module.exports = {
  getState,
  updateState,
};
