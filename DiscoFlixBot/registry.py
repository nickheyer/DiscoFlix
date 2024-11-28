import discord

class CommandRegistry:
    _instance = None

    def __new__(cls, tree=None):
        if not isinstance(cls._instance, cls):
            cls._instance = super(CommandRegistry, cls).__new__(cls)
            cls._instance.init(tree)
        return cls._instance

    def init(self, tree):
        self.commands = {}
        self.tree = tree

    def register(self, command_cls_list=[]):
        for command_cls in command_cls_list:
            command = command_cls()
            print(f'REGISTERING COMMAND: {command.name}')

            if command.name not in command.aliases: # Defaulting name to cmd
                command.aliases.append(command.name)

            for alias in command.aliases:
                print(f'REGISTERING ALIAS: {alias} / {command}')
                self.commands[alias] = command
              
            if command.slash_enabled:
                self._update_slash_command(command)

    def _update_slash_command(self, cmd):
        command = discord.app_commands.Command(
            name=cmd.name,
            description=cmd.description,
            callback=self.cb_factory(cmd.requires_input),
            guild_ids=None,
        )
        self.tree.add_command(command, override=True)

    def cb_factory(self, requires_input: bool):
        if requires_input:
            async def stub_callback_with_arg(interaction: discord.Interaction, input: str):
                pass
            return stub_callback_with_arg
        else:
            async def stub_callback(interaction: discord.Interaction):
                pass
            return stub_callback

    def get_filtered_commands(self, **kwargs):
        return {
            name: cls_inst
            for name, cls_inst in self.commands.items()
            if all(getattr(cls_inst, key, None) == value for key, value in kwargs.items())
        }

    def get(self, name, **kwargs):
        command_dict = self.get_filtered_commands(**kwargs)
        command_list = "\n".join([f"{name} : {cls_inst.name}" for name, cls_inst in command_dict.items()])
        print(f'GETTING ALL COMMANDS: {command_list}')
        return command_dict.get(name)

    def all(self, **kwargs):
        command_dict = self.get_filtered_commands(**kwargs)
        if not command_dict:
            return []

        return set(command_dict.values())
        