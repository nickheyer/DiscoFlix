from django.core.management.base import BaseCommand
import asyncio
import websockets
import json
from multiprocessing import Process
from DiscoFlixClient.utils import get_state_sync, add_log_sync

# A BS HACK TO SPIN UP AN EVENT LOOP FOR PRE-REQUEST BOT STARTUP
class Command(BaseCommand):
    help = 'To run when application is launched'

    def handle(self, *args, **kwargs):
        state = get_state_sync()
        discord_state = state.discord_state
        add_log_sync('[CLIENT] STARTUP: SERVER STARTING UP')

        if discord_state: # IF WE LEFT THE BOT RUNNING AT SIGTERM, ETC.
          add_log_sync('[BOT] STARTUP: BOT STARTING UP')
          uri = f"ws://localhost:5454/ws/client/"
          self.stdout.write(f"Connecting to: {uri}")
          p = Process(target=self.ws_client, args=(uri,))
          p.start()

    @staticmethod
    def ws_client(uri):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def bot_starter_ws_client():
            async with websockets.connect(uri) as websocket:
                bot_on_data = {
                    "event": "bot_on",
                    "data": { 'validation_bypass': True }
                }
                await websocket.send(json.dumps(bot_on_data))
                await websocket.recv()

        loop.run_until_complete(bot_starter_ws_client())
