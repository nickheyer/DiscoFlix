from datetime import datetime, timedelta

from django.db import connection, models
from django.conf import settings
from django.core.management import call_command
from django.forms.models import model_to_dict
from django.apps import apps
from channels.db import database_sync_to_async
from django.core.exceptions import ObjectDoesNotExist
from asgiref.sync import async_to_sync, sync_to_async
from django.core.management.color import color_style
from rest_framework.authtoken.models import Token
import openai

import os
import requests
import io
import subprocess
import json
import threading
import sys
import signal

from DiscoFlixClient.models import (
    Configuration,
    State,
    ErrLog,
    EventLog,
    MediaRequest,
    User,
    Media,
    DiscordServer,
    UserManager
)

from DiscoFlixBot.lib.api import radarr, sonarr

style = color_style()

@database_sync_to_async
def save_instance(instance):
    instance.save()
    

def get_config_sync():
    try:
        return Configuration.objects.first()
    except ObjectDoesNotExist:
        return None


@database_sync_to_async
def get_config():
    return get_config_sync()


@database_sync_to_async
def get_config_dict():
    config = get_config_sync()
    return model_to_dict(config)


@database_sync_to_async
def update_config(data):
    config = get_config_sync()
    changed = []
    for k, v in data.items():
        if hasattr(config, k):
            attribute = getattr(config, k)
            if str(attribute) != str(v) and (attribute or v):
                changed.append(k)
            setattr(config, k, v)
    config.save()
    config_dict = model_to_dict(config)
    config_dict["changed"] = changed
    return config_dict


def get_state_sync():
    try:
        return State.objects.first()
    except ObjectDoesNotExist:
        return None


@database_sync_to_async
def get_state():
    return get_state_sync()


@database_sync_to_async
def get_state_dict():
    state = get_state_sync()
    return model_to_dict(state)


def update_state_sync(data):
    state = get_state_sync()
    changed = []
    for k, v in data.items():
        if hasattr(state, k):
            attribute = getattr(state, k)
            if str(attribute) != str(v):
                changed.append(k)
            setattr(state, k, v)
    state.save()
    state_dict = model_to_dict(state)
    state_dict["changed"] = changed
    return state_dict


@database_sync_to_async
def update_state(data):
    update_state_sync(data)


@database_sync_to_async
def get_logs(num):
    try:
        logs = EventLog.objects.all().order_by("-created")[:num]
        if logs.exists():
            return [
                f"{log.created.strftime('%Y-%m-%d %H:%M:%S')}: {log.entry}"
                for log in logs
            ][::-1]
        else:
            print("No logs found")
            return []
    except Exception as e:
        print(f"Error fetching logs: {e}")
        return []


def add_log_sync(entry):
    print(style.SUCCESS(f"LOGGED: {entry}"))
    try:
        EventLog.objects.create(entry=entry)
    except Exception as e:
        print(f"Error adding log: {e}")


@database_sync_to_async
def add_log(entry):
    add_log_sync(entry)


@database_sync_to_async
def add_refresh_log(entry, num=100):
    try:
        EventLog.objects.create(entry=entry)
    except Exception as e:
        print(f"Error adding log: {e}")
    try:
        logs = EventLog.objects.all().order_by("-created")[:num]
        if logs.exists():
            return [
                f"{log.created.strftime('%Y-%m-%d %H:%M:%S')}: {log.entry}"
                for log in logs
            ][::-1]
        else:
            print("No logs found")
            return []
    except Exception as e:
        print(f"Error fetching logs: {e}")
        return []


@database_sync_to_async
def get_dict(model_str):
    try:
        found_model = apps.get_model("DiscoFlixClient", model_str)
    except LookupError:
        return {}
    try:
        instance = found_model.objects.first()
        if instance is None:
            return {}
        return model_to_dict(instance)
    except Exception as e:
        print(f"An error occurred: {e}")
        return {}


def get_verbose_dict_sync(model_str):
    try:
        found_model = apps.get_model("DiscoFlixClient", model_str)
    except LookupError:
        print(f"Model {model_str} not found.")
        return {}

    print(f"Checking model: {found_model}")
    try:
        instance = found_model.objects.first()
        if instance is None:
            return {}

        fields = model_to_dict(instance)
        meta_fields = found_model._meta.get_fields()
        verbose_names = {}
        field_types = {}

        for field in meta_fields:
            if hasattr(field, "name"):
                verbose_names[field.name] = field.verbose_name
                field_types[field.name] = type(field).__name__

        return {"fields": fields, "verbose": verbose_names, "types": field_types}
    except Exception as e:
        print(f"An error occurred: {e}")
        return {}


@database_sync_to_async
def get_verbose_dict(model_str):
    return get_verbose_dict_sync(model_str)

def get_user_token_sync(user_cls = None, username = None, id = None):
    if not user_cls:
       user_cls = get_user_sync(username, id)
       if not user_cls:
           return None 
    token, _created = Token.objects.get_or_create(user=user_cls)
    return token.key

@database_sync_to_async
def get_user_token(user_cls = None, username = None, id = None):
    return get_user_token_sync(user_cls, username, id)

@database_sync_to_async
def get_users_dict():
    users = User.objects.all()
    users_dict = []
    for user in users:
        user_dict = model_to_dict(user, exclude=["discord_servers", "requests"])
        user_dict['token'] = get_user_token_sync(user)
        users_dict.append(user_dict)
        
    return users_dict


@database_sync_to_async
def get_users_list():
    users = User.objects.values_list("username", flat=True)
    return list(users)


@database_sync_to_async
def add_user(info):
    username = info.get("username", None)
    if not username:
        return False

    existing = User.objects.filter(username=username).first()
    if existing:
      return False
    
    new_user = User.objects.create_user(username=username)

    for k, v in info.items():
        if k in ["id", "discord_servers", "added", "requests", "username", 'password']:
            continue
        if hasattr(new_user, k):
            field = User._meta.get_field(k)
            if isinstance(field, models.BooleanField):
                v = bool(v)
            elif isinstance(field, models.IntegerField):
                v = int(v)
            setattr(new_user, k, v)

    password = info.get('password')
    new_user.set_password(password)
    new_user.save()

    for server in info.get("servers", []):
        new_server, _ = DiscordServer.objects.get_or_create(
            server_name=server["server_name"], server_id=server["server_id"]
        )
        new_server.users.add(new_user)

    print(new_user.__dict__)
    return True


@database_sync_to_async
def edit_user(info):
    user = User.objects.filter(id=info.get("id", "-1")).first()
    if not user:
        return False

    for k, v in info.items():
        if k in ["id", "servers", "added", "requests"]:
            continue
        if hasattr(user, k):
            field = User._meta.get_field(k)
            if str(getattr(user, k)) != str(v):
                if k == 'password':
                    user.set_password(v)
                else:
                    if isinstance(field, models.BooleanField):
                        v = bool(v) if v else False
                    elif isinstance(field, models.IntegerField):
                        v = int(v) if v else 0
                    setattr(user, k, v)
                    

    user.save()

    for server in info.get("servers", []):
        new_server, _ = DiscordServer.objects.get_or_create(
            server_name=server["server_name"], server_id=server["server_id"]
        )

        if not new_server.users.filter(id=user.id).exists():
            new_server.users.add(user)

    return True

@database_sync_to_async
def delete_user(**kwargs):
    if not kwargs.get("username") and not kwargs.get("id"):
        return None
    user = User.objects.filter(**kwargs).first()
    if not user:
        return None
    username = user.username
    user.delete()
    return username


def get_user_sync(**kwargs):
    if not kwargs.get("username") and not kwargs.get("id"):
      return None
    user = User.objects.filter(**kwargs).first()
    if user:
        return user
    return None


@database_sync_to_async
def get_user_dict(**kwargs):
    user = get_user_sync(**kwargs)
    if user:
        user_dict = model_to_dict(user, exclude=["discord_servers", "requests"])
        user_dict['token'] = get_user_token_sync(user)
        return user_dict
    return None


@database_sync_to_async
def get_user(**kwargs):
    return get_user_sync(**kwargs)

@database_sync_to_async
def get_user_settings(user):
    if not user:
        return {}
    user_settings = model_to_dict(
        user,
        exclude=[
            "id",
            "added",
            "is_admin",
            "is_server_restricted",
            "username",
            "discord_servers",
            "requests",
            "is_additional_settings",
        ],
    )
    return user_settings


@database_sync_to_async
def edit_user_from_dict(data):
    user_info = data.get("user_info")
    username = user_info.get("username", None)
    user_id = user_info.get("id", None)
    user = None

    if user_id:
        user = User.objects.filter(id=user_id).first()
    elif username:
        user = User.objects.filter(username=username).first()

    if not user:
        return None

    user.username = username
    changes_made = []

    for k, v in data.items():
        if hasattr(user, k):
            data_in_model = getattr(user, k)
            if data_in_model != type(data_in_model)(v):
                changes_made.append(k)
            if k not in ["id", "discord_servers", "added", "requests", "username"]:
                setattr(user, k, v)

    user.save()

    server_list = data.get("servers", [])
    existing_server_ids = [server.server_id for server in user.discord_servers.all()]
    new_server_ids = [server["server_id"] for server in server_list]

    # Remove user from servers not in the new list
    for server_id in existing_server_ids:
        if server_id not in new_server_ids:
            server = DiscordServer.objects.get(server_id=server_id)
            server.users.remove(user)

    # Add or update user to servers in the new list
    for server_data in server_list:
        server, _created = DiscordServer.objects.get_or_create(
            server_id=server_data["server_id"]
        )
        server.server_name = server_data["server_name"]
        server.save()
        server.users.add(user)

    return changes_made


@database_sync_to_async
def get_all_user_servers(username):
    servers = DiscordServer.objects.all()
    user = User.objects.filter(username=username).first()

    user_servers = []

    for server in servers:
        server_dict = model_to_dict(server)
        server_dict["active"] = user and user in server.users.all()
        user_servers.append(server_dict)

    return user_servers


def eval_user_roles_sync(user):
    roles = []
    if isinstance(user, str):
        user, _username = User.objects.filter(username=user).first(), user
        if not user:
            return ["unregistered"]
    if user.is_admin:
        roles.extend(["user", "admin"])
    else:
        roles.append("user")
    if user.is_server_restricted:
        roles.append("restricted")
    else:
        roles.append("unrestricted")
    if user.is_superuser:
        roles.append("owner")
    return roles


@database_sync_to_async
def eval_user_roles(user):
    return eval_user_roles_sync(user)


@database_sync_to_async
def get_users_in_server(server_id, permissions=[]):
    server = DiscordServer.objects.filter(server_id=server_id).first()

    if not server:
        return []

    # Fetch users associated with the server
    users_in_server = server.users.all()

    # Fetch users who aren't server restricted
    unrestricted_users = User.objects.filter(is_server_restricted=False)

    # Combine both lists of users (deduplicate with distinct)
    relev_users = (users_in_server | unrestricted_users).distinct()

    # If no permissions were provided, just return all relevant users
    if not permissions:
        return list(relev_users.values_list("username", flat=True))

    approved_users = []
    for user in relev_users:
        user_roles = eval_user_roles_sync(user)
        is_approved = all(perm in user_roles for perm in permissions)
        if is_approved:
            approved_users.append(user.username)

    return approved_users


@database_sync_to_async
def get_user_requests_last_24_hours(username):
    try:
        user = User.objects.get(username=username)
    except User.DoesNotExist:
        return False

    now = datetime.now()
    one_day_ago = now - timedelta(days=1)

    # Filter MediaRequest instances created within the last 24 hours and requested by the given user
    recent_requests_count = user.requests.filter(created__gte=one_day_ago).count()
    # If the user has a max_requests_in_day attribute and it exceeds the recent_requests_count, return False
    if user.max_requests_in_day and recent_requests_count >= user.max_requests_in_day:
        return False
    return True


@database_sync_to_async
def get_discord_server_from_id(server_id):
    return DiscordServer.objects.filter(server_id=server_id).first()


def get_users_for_auth_sync(server_id, permissions, username):
    if (
        "unregistered" in permissions
        and not User.objects.filter(username=username).exists()
    ):
        return True
    server = DiscordServer.objects.filter(server_id=server_id).first()
    users_in_server = User.objects.filter(discord_servers=server)
    unrestricted_users = User.objects.filter(is_server_restricted=False)
    result = users_in_server | unrestricted_users

    approved_users = []
    for user in result:
        user_roles = eval_user_roles_sync(user)
        is_approved = any(perm in user_roles for perm in permissions)

        if is_approved or not permissions:
            approved_users.append(user.username)

    return username in approved_users


@database_sync_to_async
def get_users_for_auth(server_id, permissions, username):
    return get_users_for_auth_sync(server_id, permissions, username)


@database_sync_to_async
def update_servers(servers, delete = False):
    
    if delete:
        server_ids = [s["server_id"] for s in servers]
        DiscordServer.objects.exclude(server_id__in=server_ids).delete()

    for server in servers:
        _get, _created = DiscordServer.objects.get_or_create(
            server_id=server["server_id"],
            defaults={"server_name": server["server_name"]},
        )


METADATA_MAP = {
  "title": "title",
  "overview": "overview",
  "remotePoster": "poster_url",
  "year": "year",
  "path": "path",
  "monitored": "monitored",
  "runtime": "runtime",
  "added": "added",
  "seasonCount": "season_count",
  "network": "network",
  "airTime": "air_time",
  "tvdbId": "tvdb_id",
  "imdbId": "imdb_id",
  "firstAired": "first_aired",
  "seriesType": "series_type",
  "inCinemas": "in_theaters",
  "website": "website_url",
  "youTubeTrailerId": "trailer_url"
}

@database_sync_to_async
def create_media(metadata):
    mapped_metadata = {METADATA_MAP.get(k, k): v for k, v in metadata.items() if k in METADATA_MAP}
    media = Media.objects.create(**mapped_metadata)
    return media

@database_sync_to_async
def create_media_request(
    user_object, media_object, discord_server, message_str, parsed_title, content_type
):
    request = MediaRequest.objects.create(
        made_in=discord_server,
        media=media_object,
        orig_message=message_str,
        orig_parsed_title=parsed_title,
        orig_parsed_type=content_type,
    )
    request.save()
    user_object.requests.add(request)
    return request

@database_sync_to_async
def get_required_fields():
    fields = [
        "media_server_name",
        "prefix_keyword",
        "discord_token",
    ]

    config = Configuration.objects.first()
    if not config:
        return fields

    if config.is_radarr_enabled:
        fields.extend(["radarr_url", "radarr_token"])
    if config.is_sonarr_enabled:
        fields.extend(["sonarr_url", "sonarr_token"])

    return fields


@database_sync_to_async
def reset_database(choices):
    if choices.get("State", False):
        State.objects.all().delete()
    if choices.get("Configuration", False):
        Configuration.objects.all().delete()
    if choices.get("EventLog", False):
        EventLog.objects.all().delete()
        ErrLog.objects.all().delete()
    if choices.get("User", False):
        # Deleting users will likely also delete related models due to cascading
        User.objects.all().delete()
        DiscordServer.objects.all().delete()
        MediaRequest.objects.all().delete()
        Media.objects.all().delete()


@database_sync_to_async
def reset_entire_db():
    call_command("flush", "--noinput")

    # Create default State and Configuration if needed
    if not State.objects.exists():
        State.objects.create()
    if not Configuration.objects.exists():
        Configuration.objects.create()

@database_sync_to_async
def export_data(choices):
    """
    Exports data from specified models to a JSON file (buffer till it reaches client).
    """
    models_to_dump = []
    if "Configuration" in choices:
        models_to_dump.append("DiscoFlixClient.Configuration")
    if "EventLog" in choices:
        models_to_dump.append("DiscoFlixClient.EventLog")
        models_to_dump.append("DiscoFlixClient.ErrLog")
    if "User" in choices:
        models_to_dump.append("DiscoFlixClient.User")
        models_to_dump.append("DiscoFlixClient.DiscordServer")
        models_to_dump.append("DiscoFlixClient.MediaRequest")
        models_to_dump.append("DiscoFlixClient.Media")

    buffer = io.StringIO()
    call_command("dumpdata", *models_to_dump, stdout=buffer, format="json")

    dumped_data = buffer.getvalue()
    buffer.close()
    
    return dumped_data


@database_sync_to_async
def import_data(data_obj):
    """
    Imports data from a JSON string into specified models.
    """

    if not data_obj:
        return False
    
    data_str = data_obj

    process = subprocess.Popen(
        ['python', 'manage.py', 'importdata'], 
        stdin=subprocess.PIPE, 
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    stdout, stderr = process.communicate(input=data_str)
    
    if process.returncode != 0:
        print("STDOUT:", stdout)
        print("STDERR:", stderr)
        return False

    if not State.objects.exists():
        State.objects.create()
    if not Configuration.objects.exists():
        Configuration.objects.create()
    
    return True


def handle_stdout(pipe, logger=None):
    verbose_logging = get_config_sync().is_verbose_logging
    for line in pipe:
        raw = line.strip()
        log = f"[BOT OUT]: {raw}"
        if logger and verbose_logging:
            _logs = async_to_sync(logger)(log, 100)
        else:
            event = EventLog(entry=log)
            event.save()


def handle_stderr(pipe, logger=None):
    verbose_logging = get_config_sync().is_verbose_logging
    for line in pipe:
        raw = line.strip()
        log = f"[BOT ERR]: {raw}"
        if logger and verbose_logging:
            _logs = async_to_sync(logger)(log, 100)
        else:
            error = ErrLog(entry=log)
            error.save()


@database_sync_to_async
def change_bot_state(current_state):
    state = get_state_sync()
    state.discord_state = current_state
    state.save()

def validate_discord_token(token):
    print(style.SUCCESS(f"VALIDATING DISCORD TOKEN: {token}"))
    if not token:
        return False
    response = requests.get(
        "https://discord.com/api/v9/users/@me",
        headers = {"Authorization": f"Bot {token}"}
    )
    print(style.NOTICE(f"DISCORD VALIDATION RESPONSE:\n{response}"))
    return response.status_code == 200

def validate_sonarr(url, token):
    print(style.SUCCESS(f"VALIDATING SONARR CONNECTION:\n{url}\n{token}"))
    if None in [url, token]:
        return False
    try:
      sonarr_instance = sonarr.SonarrAPI(url, token)
      status = sonarr_instance.get_system_status()
      print(style.SUCCESS(f"SONARR SYSTEM STATUS:\n{status}"))
      if not status:
          return False
      return True
    except Exception as e:
      print(style.ERROR(f"SONARR ERR:\n{e}"))

    return False

def validate_radarr(url, token):
    print(style.SUCCESS(f"VALIDATING RADARR CONNECTION:\n{url}\n{token}"))
    if None in [url, token]:
        return False
    try:
      radarr_instance = radarr.RadarrAPI(url, token)
      status = radarr_instance.get_system_status()
      print(style.SUCCESS(f"RADARR SYSTEM STATUS:\n{status}"))
      if not status:
        return False
      return True
    except Exception as e:
      print(style.ERROR(f"RADARR ERR:\n{e}"))

    return False

def validate_openai_token(token):
    client = openai.OpenAI(api_key=token)
    try:
        client.models.list()
    except openai.AuthenticationError as e:
        print(style.ERROR(f"OPENAI ERR:\n{e}"))
        return False
    else:
        return True

