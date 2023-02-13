#!/bin/sh

PORT=5000

gunicorn --bind 0.0.0.0:$PORT --timeout 0 app:app
echo "Shutting down Gunicorn Server"
