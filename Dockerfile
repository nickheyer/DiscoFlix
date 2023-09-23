FROM python:3.11-slim-buster

RUN apt update && rm -rf /var/lib/apt/lists/*

COPY ./requirements.txt /app/requirements.txt

WORKDIR /app

RUN pip install --no-cache-dir -r requirements.txt

RUN apt update

COPY . /app

EXPOSE 5454

ENTRYPOINT [ "sh", "./run.sh" ]