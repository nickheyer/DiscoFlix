# DJANGO CHANNELS: https://channels.readthedocs.io/en/latest/tutorial/part_1.html

from django.shortcuts import render
from DiscoFlixClient.utils import (
    update_state_sync
)

def index(request):
    update_state_sync({ 'host_url': request.get_host() })
    return render(request, "DiscoFlixClient/index.html")