from DiscoFlixBot.base_command import Command

class EchoCommand(Command):
    name = "echo"
    requires_input = True
    permissions = ["user", "developer"]
    description = "Confirm bot can respond to messages"

    async def execute(self, message, ctx):
        await message.channel.send(ctx.primary)