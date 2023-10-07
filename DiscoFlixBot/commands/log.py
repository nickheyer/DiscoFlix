from DiscoFlixBot.base_command import Command

class LogCommand(Command):

    def __init__(self) -> None:
        super().__init__()
        self.name = "log"
        self.permissions = ["user", "developer", "owner"]
        self.description = "Confirm bot is logging information to console/server as intended"
        self.aliases = ["log"]
        self.requires_input = True


    async def execute(self, message, ctx):
        await ctx.bot.send_log(ctx.primary)
        await message.channel.send('Log added - check console in the web user-interface.')