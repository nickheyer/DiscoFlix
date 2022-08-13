#!/bin/sh

IP='ip route get 8.8.8.8 | sed -n '/src/{s/.*src *\([^ ]*\).*/\1/p;q}''
PORT=5000

gunicorn --bind $IP:$PORT app:app
echo "Shutting down Gunicorn Server"
