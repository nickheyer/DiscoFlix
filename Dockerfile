FROM python:3.10-alpine

RUN apk add --update alpine-sdk

# copy the requirements file into the image
COPY ./requirements.txt /app/requirements.txt

# switch working directory
WORKDIR /app

# Install any needed packages specified in requirements.txt
RUN apk add --no-cache --update \
    build-base \
    libffi-dev \
    && pip install --trusted-host pypi.python.org -r requirements.txt

# copy every content from the local file to the image
COPY . /app

EXPOSE 5454

# configure the container to run in an executed manner
ENTRYPOINT [ "sh", "./run.sh" ]
