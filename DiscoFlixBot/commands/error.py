from DiscoFlixBot.base_command import Command

class ErrorCommand(Command):
    name = "error"
    permissions = ["user", "developer", "owner"]
    description = "Confirm bot is handling errors as intended"

    async def execute(self, message, ctx):
        await message.channel.send("Let's throw an error!")
        raise Exception("THIS IS AN INTENDED ERROR!")