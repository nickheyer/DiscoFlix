from DiscoFlixBot.base_command import Command

class RejectCommand(Command):
    name = "reject"
    aliases = ['rejection', 'rejected', 'rej']
    permissions = ["unattainable-role"]
    description = "Confirm bot is checking permissions for incoming commands"

    async def reject(self, message, ctx):
        await message.channel.send(f'REJECTION CONFIRMED... {ctx.rejection}')