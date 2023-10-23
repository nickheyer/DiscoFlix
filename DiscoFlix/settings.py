# using Django 4.2.4

from django.core.management.utils import get_random_secret_key
from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent
BACKUPS_DIR = BASE_DIR.parent

SECRET_KEY_FILE = os.path.join(BASE_DIR, 'data', 'django_key.txt')

def get_or_create_secret_key():
    try:
        with open(SECRET_KEY_FILE, 'r') as f:
            secret = f.read().strip()
            if secret:
                return secret
    except FileNotFoundError:
        pass
    secret = get_random_secret_key()
    with open(SECRET_KEY_FILE, 'w') as f:
        f.write(secret)
    return secret

SECRET_KEY = get_or_create_secret_key()

DEBUG = True

ALLOWED_HOSTS = ["*"]
CSRF_TRUSTED_ORIGINS = ["*"]

CORS_ALLOW_ALL_ORIGINS = True

INSTALLED_APPS = [
    "daphne",
    "channels",
    "DiscoFlixClient",
    "DiscoFlixBot",
    "corsheaders",
    "rest_framework",
    "rest_framework.authtoken",
    "jazzmin",
    "drf_spectacular",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "DiscoFlix.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "DiscoFlix.wsgi.application"
ASGI_APPLICATION = "DiscoFlix.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "data/db.sqlite3",
    }
}


CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    },
}


AUTH_USER_MODEL = "DiscoFlixClient.User"

AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework.authentication.TokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.BasicAuthentication",
    ),
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
}


LANGUAGE_CODE = "en-us"

TIME_ZONE = "UTC"

USE_I18N = True

USE_TZ = True

STATIC_URL = "static/"


DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
        },
    },
    "root": {
        "handlers": ["console"],
        "level": "DEBUG",
    },
}

JAZZMIN_SETTINGS = {
    "site_title": "DiscoFlix Admin Panel",
    "site_header": "DiscoFlix",
    "site_brand": "DiscoFlix",
    "site_logo": "DiscoFlixClient/images/favicon.png",
    "login_logo": "DiscoFlixClient/images/favicon.png",
    "login_logo_dark": "DiscoFlixClient/images/favicon.png",
    "site_logo_classes": "img-circle",
    "site_icon": "DiscoFlixClient/images/favicon.png",
    "welcome_sign": "Welcome to DiscoFlix",
    "copyright": "Heyer.app Ltd",
    "search_model": ["auth.User", "auth.Group"],
    "user_avatar": None,
    "topmenu_links": [
        {"name": "Home", "url": "/", "permissions": ["auth.view_user"]},
        {
            "name": "Support",
            "url": "https://github.com/nickheyer/discoflix/issues",
            "new_window": True,
        },
        {"model": "auth.User"},
    ],
    "usermenu_links": [
        {
            "name": "Support",
            "url": "https://github.com/nickheyer/discoflix/issues",
            "new_window": True,
        },
        {"model": "auth.user"},
        {
            "name": "GitHub",
            "url": "https://github.com/nickheyer/discoflix/",
            "new_window": True,
        },
    ],
    "show_sidebar": True,
    "navigation_expanded": True,
    "default_icon_parents": "fas fa-chevron-circle-right",
    "default_icon_children": "fas fa-circle",
    "custom_css": None,
    "custom_js": "DiscoFlixClient/javascript/misc_common.js",
    "use_google_fonts_cdn": True,
    "show_ui_builder": False,
    "changeform_format": "horizontal_tabs",
    "changeform_format_overrides": {
        "auth.user": "collapsible",
        "auth.group": "vertical_tabs",
    },
    "language_chooser": False,
}
