from DiscoFlixBot.base_command import Command

class TestCommand(Command):

    def __init__(self) -> None:
        super().__init__()
        self.name = "test"
        self.permissions = ["owner", "admin"]
        self.description = "Confirm bot is on and listening"
        self.aliases = ["test"]

    async def execute(self, message, ctx):
        await message.channel.send('Testing!')