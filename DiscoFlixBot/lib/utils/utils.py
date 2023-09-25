from DiscoFlixClient.utils import get_users_in_server, add_user
from DiscoFlixBot.managers.ui_manager import ApproveNewUser, ApproveRequest


async def handle_unregistered(message, ctx):
    admins = await get_users_in_server(ctx.server_id, ["admin"])
    admin_mentions = ""

    for user in admins:
        discord_user = message.guild.get_member_named(user)
        admin_mentions += f"{discord_user.mention}\n"

    response_message = f"User requires registration before requests can be made.\nAdmin approval needed.\n{admin_mentions}"
    view = ApproveNewUser(ctx, message, admins, response_message)
    timeout = await view.send_response()
    if not timeout:
        if view.result in ["DENIED", False, None]:
            return
        user_dict = {
                "username": str(message.author),
                "is_server_restricted": True,
                "is_admin": False,
                "servers": [
                    {
                        "server_name": str(message.guild),
                        "server_id": message.guild.id,
                    }
                ],
            }
        await add_user(user_dict)
        await ctx.bot.send_log(f"Added User: {message.author} ({view.result})")
    else:
        print("Timed-Out")