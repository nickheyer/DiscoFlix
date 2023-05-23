FROM python:3.11-slim-buster

# Install system packages required by your application
RUN apt update && rm -rf /var/lib/apt/lists/*

# Copy the requirements file into the image
COPY ./requirements.txt /app/requirements.txt

# Set working directory
WORKDIR /app

# Install Python dependencies
RUN pip install --no-cache-dir \
    cython \
    greenlet \
    cffi \
    gevent \
    -r requirements.txt

RUN apt update

# Copy the rest of your application code
COPY . /app

# Expose the port your app runs on
EXPOSE 5454

# Configure the container to run as an executable
ENTRYPOINT [ "sh", "./run.sh" ]