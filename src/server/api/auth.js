const { verifyPassword } = require('../../core/models/passwords');
const {
  createSession,
  destroySession,
  isValidSession,
  SESSION_COOKIE,
  SESSION_TTL_MS
} = require('../middlewares/authHandler');

async function renderLogin(ctx) {
  const config = await ctx.core.models.configuration.get();
  if (!config.admin_password || isValidSession(ctx.cookies.get(SESSION_COOKIE))) {
    return ctx.redirect('/');
  }
  await ctx.renderPage('login', {});
}

async function processLogin(ctx) {
  const config = await ctx.core.models.configuration.get();
  if (!config.admin_password) return ctx.redirect('/');

  const { password } = ctx.request.body || {};
  if (verifyPassword(password, config.admin_password)) {
    ctx.cookies.set(SESSION_COOKIE, createSession(), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS
    });
    return ctx.redirect('/');
  }

  ctx.core.logger.warn('Failed web console login attempt');
  ctx.status = 401;
  await ctx.renderPage('login', { error: 'Incorrect password' });
}

async function processLogout(ctx) {
  destroySession(ctx.cookies.get(SESSION_COOKIE));
  ctx.cookies.set(SESSION_COOKIE, null);
  return ctx.redirect('/login');
}

module.exports = {
  renderLogin,
  processLogin,
  processLogout
};
