from DiscoFlixBot.base_command import Command

class EchoCommand(Command):

    def __init__(self) -> None:
        super().__init__()
        self.name = "echo"
        self.permissions = ["user", "developer"]
        self.description = "Confirm bot can respond to messages"
        self.aliases = ["echo"]
        self.requires_input = True

    async def execute(self, message, ctx):
        await message.channel.send(ctx.primary)