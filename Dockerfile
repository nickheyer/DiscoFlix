FROM python:3.10-alpine

# copy the requirements file into the image
COPY ./requirements.txt /app/requirements.txt

# switch working directory
WORKDIR /app

# install the dependencies and packages in the requirements file
RUN pip install -r requirements.txt

# copy every content from the local file to the image
COPY . /app

# configure the container to run in an executed manner
ENTRYPOINT [ "sh", "./run.sh" ]

CMD ["gunicorn"  , "-b", "0.0.0.0:5000", "app:app"]