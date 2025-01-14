# BASE
FROM python:3.13-slim AS build

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
FROM python:3.13-slim AS prod

WORKDIR /app
COPY . /app/
COPY --from=build /app/requirements.txt .

RUN set -ex \
    && if id -u 1000 >/dev/null 2>&1; then \
         userdel -r "$(id -nu 1000)"; \
       fi \
    && if getent group 1000 >/dev/null 2>&1; then \
         groupdel "$(getent group 1000 | cut -d: -f1)"; \
       fi \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends procps \
    && pip install -r requirements.txt \
    && apt-get autoremove -y \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/* \
    && find /usr/local/lib/python3.12 -name '__pycache__' -exec rm -r {} + \
    && find /usr/local/lib/python3.12 -name '*.pyc' -delete

EXPOSE 5454
CMD ["sh", "./run.sh"]
USER root