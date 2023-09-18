import json
import logging
from functools import wraps
import os
import sys
import asyncio

from django.core.serializers.json import DjangoJSONEncoder
from channels.generic.websocket import AsyncWebsocketConsumer
from django.core.management.color import color_style
from django.forms.models import model_to_dict

from DiscoFlixBot.controller import (
    main,
    kill,
)

from DiscoFlixBot.bot import DiscordBot

from DiscoFlixClient.utils import (
    get_verbose_dict,
    get_dict,
    get_logs,
    get_users_dict,
    add_refresh_log,
    update_config,
    get_config,
    add_user,
    edit_user,
    delete_user,
    get_user,
    get_user_dict,
    reset_entire_db,
    update_state,
    get_users_list,
    get_all_user_servers,
    update_servers,
    change_bot_state,
    get_state,
)


style = color_style()
logger = logging.getLogger(__name__)


def event_handler(event_name):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            return await func(*args, **kwargs)

        wrapper.event_name = event_name
        return wrapper

    return decorator


class ClientConsumer(AsyncWebsocketConsumer):
    event_handlers = {}
    active_consumers = set()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        for name, value in ClientConsumer.__dict__.items():
            if hasattr(value, "event_name"):
                self.event_handlers[value.event_name] = value

    async def connect(self):
        logger.debug("CONNECTED TO CLIENT WEBSOCKET!")
        ClientConsumer.active_consumers.add(self)
        await self.accept()

    async def disconnect(self, close_code):
        ClientConsumer.active_consumers.remove(self)

    async def receive(self, text_data):
        text_data_json = json.loads(text_data)
        event = text_data_json.get("event")
        data = text_data_json.get("data")
        callback_id = data.get("callbackId")

        logger.debug(text_data_json)

        handler = self.event_handlers.get(event)
        if handler:
            await handler(self, data, callback_id)

    async def emit(self, data):
        return await self.send(text_data=json.dumps(data, cls=DjangoJSONEncoder))

    async def send_log(self, entry, num=100):
        logs = await add_refresh_log(f"[CLIENT] {entry}", num)
        return await self.emit({"event": "bot_log_added", "data": {"log": logs}})

    async def shutdown_server(self, *args, **kwargs):
        await update_state({"discord_state": False, "current_activity": "Offline"})
        if sys.platform in ["linux", "linux2"]:
            os.system("pkill -f daphne")
        else:
            os.system("pkill -f django")
        sys.exit()

    async def update_client(self, callback_id=None):
        response_data = {
            "event": "client_info",
            "data": {
                "config": await get_verbose_dict("Configuration"),
                "state": await get_dict("State"),
                "log": await get_logs(100),
                "users": await get_users_dict(),
            },
        }

        if callback_id:
            response_data["callbackId"] = callback_id

        await self.emit(response_data)

    # CLIENT COMMANDS/ROUTES

    @event_handler("client_connect")
    async def client_connect(self, _data=None, callback_id=None):
        await self.update_client(callback_id)

    @event_handler("get_config")
    async def get_config(self, _data=None, callback_id=None):
        response_data = await get_dict("Configuration")
        response_data["callbackId"] = callback_id
        await self.emit({"event": "config", "data": response_data})

    @event_handler("update_config")
    async def update_config(self, data=None, callback_id=None):
        response_data = await update_config(data)
        if len(response_data.get("changed", [])) > 0:
            verbose_config = await get_verbose_dict("Configuration")
            verbose_names = verbose_config.get("verbose")

            updated_configs = ", ".join(
                [
                    verbose_names[verb] if verbose_names.get(verb) else verb
                    for verb in response_data["changed"]
                ]
            )
            await self.send_log(f"Configuration updated: {updated_configs}")
        response_data["callbackId"] = callback_id
        await self.emit({"event": "config_updated", "data": response_data})

    @event_handler("add_user_from_client")
    async def add_user_from_client(self, data=None, callback_id=None):
        user_info = data.get("user_info")
        added = await add_user(user_info)
        if not added:
            await self.emit(
                {
                    "callbackId": callback_id,
                    "data": {
                        "username": user_info.get("username"),
                        "error": "User already exists!",
                    },
                }
            )
        else:
            await self.emit(
                {
                    "callbackId": callback_id,
                    "data": {
                        "username": user_info.get("username"),
                        "success": "User added.",
                    },
                }
            )
            response_data = {"users": await get_users_dict()}
            await self.send_log(f"User added: {user_info.get('username')}")
            await self.emit({"event": "users_updated", "data": response_data})

    @event_handler("edit_user_from_client")
    async def edit_user_from_client(self, data=None, callback_id=None):
        user_info = data.get("user_info")
        added = await edit_user(user_info)
        if not added:
            await self.emit(
                {
                    "callbackId": callback_id,
                    "data": {
                        "username": user_info.get("username"),
                        "error": "Nothing changed!",
                    },
                }
            )
        else:
            await self.emit(
                {
                    "callbackId": callback_id,
                    "data": {
                        "username": user_info.get("username"),
                        "success": "User edited.",
                    },
                }
            )
            response_data = {"users": await get_users_dict()}
            await self.send_log(f"User edited: {user_info.get('username')}")
            await self.emit({"event": "users_updated", "data": response_data})

    @event_handler("get_user_info_from_id")
    async def get_user_info_from_id(self, data=None, callback_id=None):
        response_data =  await get_user_dict(id=data.get("id"))
        await self.emit({"callbackId": callback_id, "data": response_data})

    @event_handler("delete_user")
    async def delete_user_with_dict(self, data=None, callback_id=None):
        response_data = await delete_user(id=data.get("user_id"))

        if not response_data:
            response_data = {"error": "Unable to delete user"}

        await self.emit({"callbackId": callback_id, "data": response_data})

        updated_users = {"users": await get_users_dict()}
        await self.emit({"event": "users_updated", "data": updated_users})

    @event_handler("reset_db_from_client")
    async def reset_db(self, _data=None, callback_id=None):
        # kill_all_bots()
        try:
            await reset_entire_db()
            response = {"reset_success": True}
        except Exception:
            response = {"reset_success": False}
        await self.emit({"callbackId": callback_id, "data": response})

    @event_handler("server_off")
    async def turn_server_off(self, _data=None, _callback_id=None):
        await self.shutdown_server()

    @event_handler("change_client_status")
    async def change_presence(self, data=None, callback_id=None):
        status = {"current_activity": data.get("status", "Waiting for input...")}
        await update_state(status)
        await self.emit({"callbackId": callback_id, "data": status})

    @event_handler("get_unadded_users")
    async def get_unadded_users_from_bot(self, _data=None, _callback_id=None):
        users = await get_users_list()
        unadded = await DiscordBot().get_unadded_users(users)
        await self.emit({"event": "unadded_users_sent", "data": {"unadded": unadded}})

    @event_handler("request_servers_from_client")
    async def request_servers_from_client(self, data=None, callback_id=None):
        await DiscordBot().get_servers()
        server_list = await get_all_user_servers(data.get("username"))
        await self.emit({"callbackId": callback_id, "data": {"servers": server_list}})

    # BOT COMMANDS/ROUTES

    @event_handler("bot_on")
    async def turn_bot_on(self, _data=None, _callback_id=None):
        await change_bot_state(True)
        print(style.NOTICE("[Bot] - PROCESS IS BEING STARTED..."))
        await main()
        await self.update_client()

        print(style.SUCCESS("[Bot] - BOT IS FINSIHED STARTING!..."))

    @event_handler("bot_off")
    async def turn_bot_off(self, _data=None, _callback_id=None):
        await change_bot_state(False)
        print(style.NOTICE("[Bot] - PROCESS IS BEING KILLED..."))
        await kill()
        await self.send_log("USER: BOT SHUTTING DOWN")
        await self.update_client()

        print(style.SUCCESS("[Bot] - BOT IS KILLED!..."))
