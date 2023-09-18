import re
import asyncio

from DiscoFlixClient.utils import get_users_for_auth, get_user_settings, get_user
from DiscoFlixBot.registry import CommandRegistry

class MessageHandler:
    def __init__(self, bot, message, config) -> None:
        
        self.bot = bot
        self.message = message
        self.message_content = message.content
        self.server_id = message.guild.id
        
        self.config = config

        self.command = None
        self.primary = None
        self.is_slash = hasattr(message, 'is_slash')

        self.verifier = self.__parse_message()
        self.rejection = None
        
        
    async def __parse_message(self):
        
        req_parsing_steps = [ # WILL IGNORE MESSAGE ON FAILURE
          self.__parse_sender,
          self.__parse_prefix,
          self.__parse_command
        ]

        addtional_steps = [ # WILL TRIGGER COMMAND.REJECT IF EXISTS
          (self.__parse_permissions, 'Failed to validate user request based on current permissions or state.'),
          (self.__parse_conditions, 'Conditions missing for command usage.'),
          (self.__parse_slash, 'Slash command not allowed for this command usage.'),
          (self.__parse_args, 'Failed to parse command arguments. Arguments invalid.'),
        ]

        for step in req_parsing_steps:
            result = await step() if asyncio.iscoroutinefunction(step) else step()
            if not result:
                print(f'FAILED: {step}')
                return False

        for step, rej in addtional_steps:
            result = await step() if asyncio.iscoroutinefunction(step) else step()
            if not result:
                print(f'FAILED: {step}')
                self.rejection = rej
                return False         
        return True
            
    async def __parse_sender(self):
        self.sender = self.message.author
        self.username = str(self.message.author)
        self.is_bot = self.sender.bot
        self.user = await get_user(username=self.username)
        self.user_settings = get_user_settings(self.user)
        return not self.is_bot

    def __parse_prefix(self):
        prefix = self.config.prefix_keyword
        self.split_message = self.message_content.strip().split()
        return len(self.split_message) > 1 and self.split_message[0] == prefix

    def __parse_command(self):
        if len(self.split_message) < 2:
            return False
        else:
            registry = CommandRegistry()
            cmd_str = self.split_message[1].lower()
            print(f'INCOMING COMMAND: {cmd_str}')
            cmd = registry.get(cmd_str)
            print(f'PULLED FROM REGISTRY: {cmd}')
            if cmd:
                self.command = cmd
                return True

    def __parse_slash(self):
        if self.is_slash:
          return self.command.slash_enabled
        else:
          return True
        
    async def __parse_permissions(self):
        permissions = self.command.permissions
        if not permissions:
            return True
        return await get_users_for_auth(self.server_id, permissions, self.username)
    
    def __parse_conditions(self):
        conditions = self.command.conditions
        print(f'CONDITIONS (ALL): {conditions}')
        for requirement in conditions:
            print(f'REQUIREMENT: {requirement} ({type(requirement)})')
            if isinstance(requirement, tuple):
                fn = requirement[0]
                result = fn(*requirement[1])
                if not result:
                    return False
            elif hasattr(requirement, "__call__"):
                fn = requirement
                result = fn()
                if not result:
                    return False
            elif isinstance(requirement, str):
                config_setting = getattr(self.config, requirement, False)
                print(f'CHECKING CONFIG: {config_setting}')
                if not config_setting:
                    return False
            else:
                if not requirement:
                    return False
        return True

    def __parse_args(self):
        if not self.command.requires_input:
            return True
        if len(self.split_message) < 3:
            return False
        else:
            self.primary = ' '.join(self.split_message[2:])
            return True
        
    async def _default(*args):
        return None

    async def get_fn(self):
        print('IN GET FN')
        if not (await self.verifier):
            if self.rejection and hasattr(self.command, 'reject'):
                print('IN REJECT!')
                fn = self.command.reject
            else:
                print('IN DEFAULT :(')
                fn = self._default
        else:
            print('IN EXECUTE!')
            fn = self.command.execute
        self.fn = lambda: fn(self.message, self)
        return self.fn

class FromInteraction:
    def __init__(self, interaction, config) -> None:
        self.config = config
        self.interaction = interaction
        self.id = interaction.id
        self.channel = interaction.channel
        self.created_at = interaction.created_at
        self.author = interaction.user
        self.guild = interaction.guild
        self.command = interaction.data.get('name', '')
        self.content = f'{self.config.prefix_keyword} {self.command} '
        for text in interaction.data.get('options', []):
            self.content+= text.get('value', '')
        self.type = interaction.type
        self.application_id = interaction.application_id
        self.is_slash = True
        self.components = []
        self.attachments = []
        self.embeds = []
        self.mention_everyone = False
        self.mentions = [self.guild.get_member(int(match)) for match in re.findall(r"<@!?([0-9]{15,20})>", self.content)]
        self.nonce = None
        self.pinned = False
        self.reactions = []
    
    async def reply(self, *args, **kwargs):
        return await self.channel.send( *args, **kwargs)
    
    async def edit(self):
        return True
    
    async def delete(self):
        return True