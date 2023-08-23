import json

from channels.generic.websocket import WebsocketConsumer


class ClientConsumer(WebsocketConsumer):
    def connect(self):
        print('CONNECTED TO CLIENT WEBSOCKET!')
        self.accept()

    def disconnect(self, close_code):
        pass

    def receive(self, text_data):
        print(f'DATA RECIEVED: {text_data}')
        text_data_json = json.loads(text_data)
        #message = text_data_json["message"]
        self.send(text_data=json.dumps({"message": 'HELLO THERE!'}))