from DiscoFlixBot.base_command import Command
from DiscoFlixBot.managers.ui_manager import ListCommands
from DiscoFlixBot.registry import CommandRegistry

class HelpCommand(Command):
    name = "help"
    permissions = ["user", "developer", "unregistered"]
    description = "Display all authorized commands."

    async def execute(self, message, ctx):
        registry = CommandRegistry()
        all_commands = registry.all()
        commands = ListCommands(ctx, all_commands)
        embed = await commands.generate_embed()
        await message.reply(embed=embed)