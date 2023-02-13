#!/bin/sh

PORT=5000

gunicorn --bind 0.0.0.0:$PORT --timeout 0 --log-level debug app:app
echo "Shutting down Gunicorn Server"
