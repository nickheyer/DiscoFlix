const { createUser, getAllUsers } = require('../../shared/models/user');

async function createUserHandler(ctx) {
    const newUser = await createUser(ctx.request.body);
    ctx.status = 201;
    ctx.body = newUser;
}

async function getAllUsersHandler(ctx) {
    const users = await getAllUsers();
    ctx.status = 200;
    ctx.body = users;
}

module.exports = {
  createUserHandler,
  getAllUsersHandler,
};
