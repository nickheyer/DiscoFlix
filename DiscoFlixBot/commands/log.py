from DiscoFlixBot.base_command import Command

class LogCommand(Command):
    name = "log"
    requires_input = True
    permissions = ["user", "developer", "owner"]
    description = "Confirm bot is logging information to console/server as intended"

    async def execute(self, message, ctx):
        await ctx.bot.send_log(ctx.primary)
        await message.channel.send('Log added - check console in the web user-interface.')