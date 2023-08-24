import json

from channels.generic.websocket import WebsocketConsumer


class ClientConsumer(WebsocketConsumer):
    def connect(self):
        print('CONNECTED TO CLIENT WEBSOCKET!')
        self.accept()

    def disconnect(self, close_code):
        pass

    def receive(self, text_data):
        message = json.loads(text_data)
        data = message.get('data')
        callback_id = data.get('callbackId')
        event = message.get('event')
        print(data)
        self.send(text_data=json.dumps({
            "event": event,
            "data": {
                "message": 'HELLO THERE!',
                'callbackId': callback_id
            }
        }))