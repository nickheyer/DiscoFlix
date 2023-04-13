#!/bin/sh
PORT=5454
cd src
gunicorn -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 --bind 0.0.0.0:$PORT app:app &
sleep 3
curl -s "http://localhost:5454/dbinit"
