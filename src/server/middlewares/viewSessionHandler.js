const VIEW_COOKIE = 'df_view';
const VIEW_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// EVERY ROUTE GETS THE BROWSER'S VIEW SESSION - THE df_view COOKIE NAMES THE
// ROW, UNKNOWN/MISSING COOKIES MINT ONE. ctx.viewState IS THE MERGED SHAPE
// TEMPLATES READ AS `state`; ctx.updateView WRITES VIEW FIELDS AND RE-MERGES.
function viewSessionHandler() {
  return async (ctx, next) => {
    const cookieId = ctx.cookies.get(VIEW_COOKIE);
    const row = await ctx.core.models.viewSession.resolve(cookieId);
    if (row.id !== cookieId) {
      ctx.cookies.set(VIEW_COOKIE, row.id, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: VIEW_COOKIE_MAX_AGE_MS,
        overwrite: true
      });
    }
    ctx.view = row;
    ctx.viewState = await ctx.core.models.viewSession.viewStateOf(row);
    ctx.updateView = (fields) => ctx.core.models.viewSession.updateView(row.id, fields);
    await next();
  };
}

module.exports = { viewSessionHandler, VIEW_COOKIE };
