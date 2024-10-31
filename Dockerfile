# BASE
FROM python:3.12-slim as build

ENV PIP_DEFAULT_TIMEOUT=100 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    POETRY_VERSION=1.8.4

WORKDIR /app
COPY pyproject.toml poetry.lock ./
RUN pip install "poetry==$POETRY_VERSION" \
    && poetry config warnings.export false \
    && poetry install --no-root --no-ansi --no-interaction \
    && poetry export -f requirements.txt -o requirements.txt

# PROD
FROM python:3.12-slim as prod

WORKDIR /app
COPY . /app/
COPY --from=build /app/requirements.txt .

RUN set -ex \
    && addgroup --system --gid 1001 worker \
    && adduser --system --uid 1001 --gid 1001 --no-create-home worker \
    && chown -R worker:worker /app \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y procps \
    && pip install -r requirements.txt \
    && apt-get autoremove -y \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/* && \
    find /usr/local/lib/python3.12 -name '__pycache__' -exec rm -r {} + && \
    find /usr/local/lib/python3.12 -name '*.pyc' -delete

EXPOSE 5454
CMD ["sh", "./run.sh"]
USER worker
