import json
import logging
from functools import wraps
import os
import sys
from django.core.serializers.json import DjangoJSONEncoder
from channels.generic.websocket import AsyncWebsocketConsumer

from DiscoFlixClient.utils import (
    get_verbose_dict,
    get_dict,
    get_logs,
    get_users_dict,
    add_refresh_log,
    update_config,
    add_user,
    add_edit_user,
    get_user_from_id,
    reset_entire_db
)

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
  def __init__(self, *args, **kwargs):
    super().__init__(*args, **kwargs)

    for name, value in ClientConsumer.__dict__.items():
      if hasattr(value, 'event_name'):
        self.event_handlers[value.event_name] = value

  async def connect(self):
    logger.debug('CONNECTED TO CLIENT WEBSOCKET!')
    await self.accept()

  async def disconnect(self, close_code):
    pass

  async def receive(self, text_data):
    text_data_json = json.loads(text_data)
    event = text_data_json.get("event")
    data = text_data_json.get("data")
    callbackId = data.get("callbackId")

    logger.debug(text_data_json)

    handler = self.event_handlers.get(event)
    if handler:
      await handler(self, data, callbackId)

  async def emit(self, data):
    return await self.send(text_data=json.dumps(data, cls=DjangoJSONEncoder))

  async def send_log(self, entry):
    logs = await add_refresh_log(entry, 100)
    return await self.emit({'event': 'bot_log_added', 'data': {'log': logs}})

  async def shutdown_server(self):
      #kill_all_bots()
      if sys.platform in ["linux", "linux2"]:
          os.system("pkill -f daphne")
      try:
          os.system("pkill -f django")
      except:
          pass
      sys.exit()

  @event_handler('client_connect')
  async def client_connect(self, data, callbackId):
    response_data = {
      "event": "client_info",
      "callbackId": callbackId,
      "data": {
        "config": await get_verbose_dict("Configuration"),
        "state": await get_dict("State"),
        "log": await get_logs(100),
        "users": await get_users_dict(),
      }
    }
    await self.emit(response_data)

  @event_handler('get_config')
  async def get_config(self, data, callbackId):
    response_data = await get_dict("Configuration")
    response_data["callbackId"] = callbackId
    await self.emit({"event": "config", "data": response_data})

  @event_handler("update_config")
  async def update_config(self, data, callbackId):
    response_data = await update_config(data)
    if len(response_data.get("changed", [])) > 0:
        
        verbose_config = await get_verbose_dict('Configuration')
        verbose_names = verbose_config.get('verbose')

        updated_configs = ", ".join([verbose_names[verb] if verbose_names.get(verb) else verb for verb in response_data["changed"]])
        await self.send_log(f"Configuration updated: {updated_configs}")
    response_data["callbackId"] = callbackId
    await self.emit({"event": "config_updated", "data": response_data})

  @event_handler("add_user_from_client")
  async def add_user_from_client(self, data, callbackId):
    user_info = data.get('user_info')
    added = await add_user(user_info)
    if not added:
      await self.emit({
        "callbackId": callbackId,
        "data": {
            "username": user_info.get('username'),
            "error": "User already exists!"
        }
      })
    else:
      await self.emit({
        "callbackId": callbackId,
        "data": {"username": user_info.get('username'), "success": "User added."}
      })
      response_data = { "users": await get_users_dict() }
      await self.send_log(f"User added: {user_info.get('username')}")
      await self.emit({"event": "users_updated", "data": response_data})
  
  @event_handler("edit_user_from_client")
  async def edit_user_from_client(self, data, callbackId):
    user_info = data.get('user_info')
    added = await add_user(user_info)
    if not added:
      await self.emit({
        "callbackId": callbackId,
        "data": {
            "username": user_info.get('username'),
            "error": "Nothing changed!"
        }
      })
    else:
      await self.emit({
        "callbackId": callbackId,
        "data": {"username": user_info.get('username'), "success": "User edited."}
      })
      response_data = { "users": await get_users_dict() }
      await self.send_log(f"User edited: {user_info.get('username')}")
      await self.emit({"event": "users_updated", "data": response_data})
  
  @event_handler("get_user_info_from_id")
  async def get_user_info_from_id(self, data, callbackId):
    response_data = await get_user_from_id(data.get('id'))
    await self.emit({
      "callbackId": callbackId,
      "data": response_data
    })

  @event_handler("reset_db_from_client")
  async def reset_db(self, data, callbackId):
    #kill_all_bots()
    try:
        await reset_entire_db()
        response = {"reset_success": True}
    except Exception as e:
        response = {"reset_success": False}
    await self.emit({
    "callbackId": callbackId,
    "data": response
    })

  @event_handler("server_off")
  async def turn_server_off(self, data, callbackId):
      await self.shutdown_server()
