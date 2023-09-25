import discord

from DiscoFlixClient.utils import (
    eval_user_roles,
    get_users_in_server,
    get_user,
    get_user_requests_last_24_hours,
)


async def requires_admin(cls, seasons):
  if not cls.user_config.is_admin and (
    (
        seasons is not None
        and cls.config.max_seasons_for_non_admin is not None
        and cls.config.max_seasons_for_non_admin != 0
        and seasons > cls.config.max_seasons_for_non_admin
    )
    or not await get_user_requests_last_24_hours(cls.author)
  ):
    return True
  return False