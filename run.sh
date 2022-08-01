#!/bin/sh

IP='ip route get 8.8.8.8 | sed -n '/src/{s/.*src *\([^ ]*\).*/\1/p;q}''

gunicorn --bind $IP:5000 app:app
echo "Shutting down Gunicorn Server"
