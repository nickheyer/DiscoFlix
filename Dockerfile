FROM python:3.11-slim-buster

RUN apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        python3-dev

RUN pip install --upgrade pip

COPY ./requirements.txt /app/requirements.txt

WORKDIR /app

RUN pip install --no-cache-dir \
    cython \
    greenlet \
    cffi \
    gevent \
    -r requirements.txt

RUN apt update

COPY . /app

EXPOSE 5454

ENTRYPOINT [ "sh", "./run.sh" ]