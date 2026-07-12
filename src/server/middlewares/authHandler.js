const crypto = require('crypto');

// SESSION-COOKIE AUTH FOR THE WEB CONSOLE
const SESSION_COOKIE = 'df_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login']);

const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const entry = sessions.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// STATIC ASSETS ARE SERVED BY EARLIER MIDDLEWARE AND NEVER REACH THIS —
// ONLY ROUTES NEED GUARDING
function authHandler() {
  return async (ctx, next) => {
    // LOCKOUT RECOVERY HATCH: RESTART WITH DF_DISABLE_AUTH=1, THEN CLEAR THE
    // PASSWORD FROM THE CONFIGURATION MODAL
    if (process.env.DF_DISABLE_AUTH === '1') return next();
    const config = await ctx.core.models.configuration.get();
    if (!config.admin_password) return next();
    if (PUBLIC_PATHS.has(ctx.path)) return next();
    if (isValidSession(ctx.cookies.get(SESSION_COOKIE))) return next();

    // htmx CALLS GET A CLIENT-SIDE REDIRECT; PLAIN NAVIGATION A 302
    if (ctx.get('HX-Request')) {
      ctx.set('HX-Redirect', '/login');
      ctx.status = 401;
      return;
    }
    return ctx.redirect('/login');
  };
}

module.exports = {
  authHandler,
  createSession,
  isValidSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS
};
