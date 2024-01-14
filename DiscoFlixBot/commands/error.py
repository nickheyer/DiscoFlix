from DiscoFlixBot.base_command import Command

class ErrorCommand(Command):

    def __init__(self) -> None:
        super().__init__()
        self.name = "error"
        self.permissions = ["developer", "owner"]
        self.description = "Confirm bot is handling errors as intended"
        self.aliases = ["error"]

    async def execute(self, message, ctx):
        await message.channel.send("Let's throw an error!")
        raise Exception("THIS IS AN INTENDED ERROR!")