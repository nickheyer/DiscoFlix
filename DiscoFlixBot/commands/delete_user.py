from DiscoFlixBot.base_command import Command
from DiscoFlixClient.utils import get_user, delete_user
from discord import Color, Embed


class DeleteUserCommand(Command):
    name = "delete-user"
    permissions = ["admin", "owner"]
    description = "Remove/modify users"
    aliases = ["remove", "delete", "rm", "del"]
    requires_input = True

    async def execute(self, message, ctx):
        users_to_rm = []
        rm_admins = ctx.user.is_superuser
        if len(message.mentions) == 0:
            existing = await get_user(username=ctx.primary, is_admin=rm_admins, is_superuser=False)
            if existing:
                users_to_rm.append(ctx.primary)
        else:
            for user in message.mentions:
                existing = await get_user(username=str(user), is_admin=rm_admins, is_superuser=False)
                if existing:
                    users_to_rm.append(str(user))

        if not users_to_rm:
            final_color = Color.brand_red()
            final_title = "No Users To Delete"
            description = "Note: User(s) were not found in database. Please confirm user exists!"

        else:
            final_color = Color.brand_green()
            final_title = "Authorization Granted"
            user_mentions = []
            for username in users_to_rm:
                await delete_user(username=username)
                await ctx.bot.send_log(f"DELETED USER: {username}")
                user_mention = message.guild.get_member_named(username)
                if user_mention:
                    user_mentions.append(user_mention.mention)
                else:  # User not found by bot - Check permissions
                    user_mentions.append(username)
                    if ctx.config.is_debug:
                        await ctx.bot.send_log(
                            f"USER {username} NOT FOUND IN SERVER - CHECK PERMISSIONS TO BOT"
                        )

            description = f"{message.author.mention} Deleted: {', '.join(user_mentions)}"

        embed = Embed(title=final_title, color=final_color, description=description)
        await message.reply(embed=embed)
        await ctx.bot.update_client()
