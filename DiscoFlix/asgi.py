"""
ASGI config for DiscoFlix project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/4.2/howto/deployment/asgi/
"""

import os
import django
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from channels.security.websocket import AllowedHostsOriginValidator
from django.core.asgi import get_asgi_application
from django.core.management import call_command
import atexit

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'DiscoFlix.settings')
django.setup()

from DiscoFlixClient.routing import websocket_urlpatterns as client_websocket


# Initialize Django ASGI application early to ensure the AppRegistry
# is populated before importing code that may import ORM models.
django_asgi_app = get_asgi_application()

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": AllowedHostsOriginValidator(
        AuthMiddlewareStack(URLRouter([
          *client_websocket
        ]))
    ),
})

# AT EXIT CMD
atexit.register(call_command, 'sigint')

# AT STARTUP CMD
call_command('initializedb')
call_command('startloop')

