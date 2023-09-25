import json
import os
import sys
import importlib
import discord
import asyncio

from DiscoFlixClient.utils import (
    get_verbose_dict,
    get_dict,
    get_logs,
    get_users_dict,
    add_refresh_log,
    update_state,
    update_servers,
    change_bot_state,
)
from django.core.serializers.json import DjangoJSONEncoder
from DiscoFlixBot import events
from DiscoFlixBot.registry import CommandRegistry
from DiscoFlixBot.base_command import Command


class DiscordBot:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if not isinstance(cls._instance, cls) or cls._instance.client.is_closed():
            cls._instance = super(DiscordBot, cls).__new__(cls, *args, **kwargs)
            cls._instance._initialize_bot()
        return cls._instance

    def _initialize_bot(self):
        # DECLARING INTENTS (SEE README FOR CONTRIBUTORS)
        self.intents = discord.Intents.all()
        self.intents.members = True

        # INSTANTIATING DISCORD CLIENT
        self.client = discord.Client(intents=self.intents)

        # INSTANTIATING DISCORD COMMAND TREE
        self.tree = discord.app_commands.CommandTree(self.client)

        # REGISTERING COMMANDS
        self.registry = CommandRegistry(self.tree)
        self.registry.register(self.import_commands())

        # ATTACHING EVENT LISTENERS TO CLIENT
        self._attach_events()

    def _attach_events(self):
        @self.client.event
        async def on_guild_join(guild):
            await events.on_guild_join(self, guild)

        @self.client.event
        async def on_ready():
            await events.on_ready(self)

        @self.client.event
        async def on_message(message):
            await events.on_message(self, message)

        @self.client.event
        async def on_interaction(interaction):
            await events.on_interaction(self, interaction)

        @self.client.event
        async def on_error(_event, *args, **_kwargs):
            print('RAISING AN ERROR, HERE ARE ARGS: ')
            print(args)
            await events.on_error(self, *args)

    def get_client(self):
        return self.client

    async def start(self, token):
        async def runner(bot_token):
            async with self.client:
                await self.client.start(bot_token)

        bot_coro = runner(token)
        asyncio.create_task(bot_coro)

    async def close(self):
        await self.client.close()
        await self.emit(
            {
                "event": "bot_off_finished",
                "data": {"success": True, "bot_name": "discord"},
            }
        )

    async def emit(self, data):
        # GETTING OUR CLIENT WS CONNECTION TO SEND MESSAGES FROM BOT TO CLIENT
        from DiscoFlixClient.consumers import ClientConsumer

        websockets = ClientConsumer.active_consumers
        for consumer in websockets:
            # SENDING MSG TO ALL CURRENTLY CONNECTED CLIENTS
            asyncio.create_task(
                consumer.send(text_data=json.dumps(data, cls=DjangoJSONEncoder))
            )

    async def update_client(self):
        response_data = {
            "event": "client_info",
            "data": {
                "config": await get_verbose_dict("Configuration"),
                "state": await get_dict("State"),
                "log": await get_logs(100),
                "users": await get_users_dict(),
            },
        }
        await self.emit(response_data)

    async def send_log(self, entry, num=100):
        logs = await add_refresh_log(f"[BOT] {entry}", num)
        await self.emit({"event": "bot_log_added", "data": {"log": logs}})

    async def get_unadded_users(self, users):
        unadded = list(
            {
                str(m)
                for g in self.client.guilds
                for m in g.members
                if not m.bot and str(m) not in users
            }
        )

        return unadded

    async def get_servers(self):
        if not self.client:
            return []
        servers = [
            {"server_name": str(guild), "server_id": guild.id}
            for guild in self.client.guilds
        ]

        await update_servers(servers)
        return servers

    async def change_presence(self, presence):
        await self.client.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.watching, name=f"& {presence.lower()}"
            )
        )
        await update_state({"current_activity": presence})
        await self.update_client()

    def import_commands(self, directory="commands"):
        command_classes = []
        full_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), directory)
        sys.path.insert(0, full_path)
        command_files = [f[:-3] for f in os.listdir(full_path) if f.endswith('.py')]
        for file_name in command_files:
            module_name = f"{file_name}"
            module = importlib.import_module(module_name, 'DiscoFlixBot.commands')
            for attr_name in dir(module):
                
                attr = getattr(module, attr_name)
                if isinstance(attr, type) and issubclass(attr, Command) and attr is not Command:
                    command_classes.append(attr)
        
        #sys.path.pop(0)
        return command_classes