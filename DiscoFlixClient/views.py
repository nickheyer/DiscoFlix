# DJANGO CHANNELS: https://channels.readthedocs.io/en/latest/tutorial/part_1.html

from django.shortcuts import render

def index(request):
    return render(request, "DiscoFlixClient/index.html")