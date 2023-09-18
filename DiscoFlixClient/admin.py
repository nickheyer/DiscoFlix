from django.contrib import admin
from DiscoFlixClient.models import (
    Configuration,
    State,
    ErrLog,
    EventLog,
    MediaRequest,
    User,
    Media,
    DiscordServer
)

models_to_register = [
    Configuration,
    State,
    ErrLog,
    EventLog,
    MediaRequest,
    User,
    Media,
    DiscordServer
]

for model in models_to_register:
    admin.site.register(model)