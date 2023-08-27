import json
import logging
from functools import wraps

from channels.generic.websocket import AsyncWebsocketConsumer


from DiscoFlixClient.utils import (
    get_verbose_dict,
    get_dict,
    get_logs,
    get_users_dict
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

    handler = self.event_handlers.get(event)
    if handler:
      await handler(self, data, callbackId)

  
  @event_handler('client_connect')
  async def client_connect(self, data, callbackId):
    logger.debug(f'IN CLIENT CONNECT: {data} + {callbackId}')
    response_data = {
      "event": "client_info",
      "data": {
        "callbackId": callbackId,
        "config": await get_verbose_dict("Configuration"),
        "state": await get_dict("State"),
        "log": await get_logs(100),
        "users": await get_users_dict(),
      }
    }
    await self.send(text_data=json.dumps(response_data))

  @event_handler('get_config')
  async def get_config(self, data, callbackId):
    response_data = await get_dict("Configuration")
    response_data["callbackId"] = callbackId
    await self.send(text_data=json.dumps({"event": "config", "data": response_data}))