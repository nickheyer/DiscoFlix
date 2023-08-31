from django.urls import re_path

from DiscoFlixClient.consumers import client

websocket_urlpatterns = [
    re_path(r'ws/client/$', client.ClientConsumer.as_asgi()),
]