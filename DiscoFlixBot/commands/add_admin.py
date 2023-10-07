from DiscoFlixBot.base_command import Command
from DiscoFlixClient.utils import get_user, add_user, edit_user
from discord import Color, Embed

class AddAdminCommand(Command):

    def __init__(self) -> None:
        super().__init__()
        self.name = "add-admin"
        self.permissions = ["owner"]
        self.description = "Add/modify admins"
        self.aliases = ["admin", "mod", "op"]
        self.requires_input = True

    async def execute(self, message, ctx):
        users_to_op = []
        users_to_add = []
        if len(message.mentions) == 0:
            existing = await get_user(username=ctx.primary)
            if not existing:
                users_to_add.append(ctx.primary)
            else:
                users_to_op.append(existing)
        else:
            for user in message.mentions:
                existing = await get_user(username=str(user))
                if not existing:
                  users_to_add.append(str(user))
                else:
                  users_to_op.append(existing)

        if not users_to_add and not users_to_op:
            final_color = Color.brand_red()
            final_title = "No Users To Mod/Op"
            description = "Note: User(s) not found. Try again."

        else:
            final_color = Color.brand_green()
            final_title = "Authorization Granted"
            description = ''
            user_mentions = []
            for username in users_to_add:
                user_dict = {
                    "username": username,
                    "is_server_restricted": True,
                    "is_admin": True,
                    "servers": [
                        {
                            "server_name": str(message.guild),
                            "server_id": message.guild.id,
                        }
                    ],
                }
                await add_user(user_dict)
                await ctx.bot.send_log(f"ADDED ADMIN: {username}")
                user_mention = message.guild.get_member_named(username)
                if user_mention:
                    user_mentions.append(user_mention.mention)
                else: # User not found by bot - Check permissions
                    user_mentions.append(username)
                    if ctx.config.is_debug:
                        await ctx.bot.send_log(f"USER {username} NOT FOUND IN SERVER - CHECK PERMISSIONS TO BOT")

            for existing in users_to_op:
                user_dict = {
                    'id': existing.id,
                    'is_admin': True
                }
                await edit_user(user_dict)
                await ctx.bot.send_log(f"UPGRADED TO ADMIN: {existing.username}")
                user_mention = message.guild.get_member_named(existing.username)
                if user_mention:
                    user_mentions.append(user_mention.mention)
                else: # User not found by bot - Check permissions
                    user_mentions.append(existing.username)
                    if ctx.config.is_debug:
                        await ctx.bot.send_log(f"USER {existing.username} NOT FOUND IN SERVER - CHECK PERMISSIONS TO BOT")

            description += f"{message.author.mention} Added/Upgraded Admins: {', '.join(user_mentions)}\n"
  
        embed = Embed(title=final_title, color=final_color, description=description)
        await message.reply(embed=embed)
        await ctx.bot.update_client()