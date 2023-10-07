from DiscoFlixBot.base_command import Command

class RejectCommand(Command):

    def __init__(self) -> None:
        super().__init__()
        self.name = "reject"
        self.permissions = ["unattainable-role"]
        self.description = "Confirm bot is checking permissions for incoming commands"
        self.aliases = ["rejection", "rejected", "rej"]

    async def reject(self, message, ctx):
        await message.channel.send(f'REJECTION CONFIRMED... {ctx.rejection}')