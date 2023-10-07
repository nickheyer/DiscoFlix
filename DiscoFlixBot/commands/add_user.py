from DiscoFlixBot.base_command import Command
from DiscoFlixClient.utils import get_user, add_user
from discord import Color, Embed

class AddUserCommand(Command):

    def __init__(self) -> None:
        super().__init__()
        self.name = "add-user"
        self.permissions = ["admin", "owner"]
        self.description = "Add/modify users"
        self.aliases = ["user", "add"]
        self.requires_input = True

    async def execute(self, message, ctx):
        users_to_add = []
        if len(message.mentions) == 0:
            existing = await get_user(username=ctx.primary)
            if not existing:
                users_to_add.append(ctx.primary)
        else:
            for user in message.mentions:
                existing = await get_user(username=str(user))
                if not existing:
                    users_to_add.append(str(user))

        if not users_to_add:
            final_color = Color.brand_red()
            final_title = "No Users To Add"
            description = "Note: Users cannot be added a second time!"

        else:
            final_color = Color.brand_green()
            final_title = "Authorization Granted"
            user_mentions = []
            for username in users_to_add:
                user_dict = {
                    "username": username,
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
                await ctx.bot.send_log(f"ADDED USER: {username}")
                user_mention = message.guild.get_member_named(username)
                if user_mention:
                    user_mentions.append(user_mention.mention)
                else: # User not found by bot - Check permissions
                    user_mentions.append(username)
                    if ctx.config.is_debug:
                        await ctx.bot.send_log(f"USER {username} NOT FOUND IN SERVER - CHECK PERMISSIONS TO BOT")

            description = f"{message.author.mention} Added: {', '.join(user_mentions)}"
  
        embed = Embed(title=final_title, color=final_color, description=description)
        await message.reply(embed=embed)
        await ctx.bot.update_client()