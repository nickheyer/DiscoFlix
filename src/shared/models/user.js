const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createUser(name, email) {
  const user = await prisma.user.create({
    data: {
      name,
      email,
    },
  });
  return user;
}

async function getAllUsers() {
  const users = await prisma.user.findMany();
  return users;
}

module.exports = {
  createUser,
  getAllUsers,
};