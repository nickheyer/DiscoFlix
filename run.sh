#!/bin/sh

echo "Applying Django migrations..."
python manage.py migrate

echo "STARTING DAPHNE|DJANGO|DISCO ASGI SERVER"
daphne -b 0.0.0.0 -p 5454 DiscoFlix.asgi:application