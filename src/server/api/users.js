const { createUser, getAllUsers } = require('../../shared/models/user');

async function createUserHandler(ctx) {
  try {
    const newUser = await createUser(ctx.request.body);
    ctx.status = 201;
    ctx.body = newUser;
  } catch (error) {
    ctx.status = 400;
    ctx.body = { message: error.message };
  }
}

async function getAllUsersHandler(ctx) {
  try {
    const users = await getAllUsers();
    ctx.status = 200;
    ctx.body = users;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { message: error.message };
  }
}

module.exports = {
  createUserHandler,
  getAllUsersHandler,
};
