from django.db import connection
from django.conf import settings
from django.core.management import call_command
from django.forms.models import model_to_dict
from django.apps import apps
from channels.db import database_sync_to_async
from django.core.exceptions import ObjectDoesNotExist
import os

from DiscoFlixClient.models import (
    Configuration,
    State,
    ErrLog,
    EventLog,
    MediaRequest,
    User,
    Media,
    DiscordServer
)

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
            if str(attribute) != str(v):
                changed.append(k)
            setattr(config, k, v)
    config.save()
    config_dict = model_to_dict(config)
    config_dict['changed'] = changed
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

@database_sync_to_async
def update_state(data):
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
    state_dict['changed'] = changed
    return state_dict

@database_sync_to_async
def get_logs(num):
    try:
        logs = EventLog.objects.all().order_by('-created')[:num]
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
def add_log(entry):
    try:
        EventLog.objects.create(entry=entry)
    except Exception as e:
        print(f"Error adding log: {e}")

@database_sync_to_async
def add_refresh_log(entry, num=100):
    try:
      EventLog.objects.create(entry=entry)
    except Exception as e:
      print(f"Error adding log: {e}")
    try:
      logs = EventLog.objects.all().order_by('-created')[:num]
      if logs.exists():
        return [
          f"{log.created.strftime('%Y-%m-%d %H:%M:%S')}: {log.entry}"
          for log in logs][::-1]
      else:
        print("No logs found")
        return []
    except Exception as e:
      print(f"Error fetching logs: {e}")
      return []

@database_sync_to_async
def get_dict(model_str):
    try:
        Model = apps.get_model('DiscoFlixClient', model_str)
    except LookupError:
        print(f"Model {model_str} not found.")
        return {}

    print(f"Checking model: {Model}")
    try:
        instance = Model.objects.first()
        if instance is None:
            print(f"No instances of {Model} found.")
            return {}

        print(f"Instance of {Model} found: {instance}")
        return model_to_dict(instance)
    except Exception as e:
        print(f"An error occurred: {e}")
        return {}

def get_verbose_dict_sync(model_str):
    try:
        Model = apps.get_model('DiscoFlixClient', model_str)
    except LookupError:
        print(f"Model {model_str} not found.")
        return {}

    print(f"Checking model: {Model}")
    try:
        instance = Model.objects.first()
        if instance is None:
            print(f"No instances of {Model} found.")
            return {}

        print(f"Instance of {Model} found: {instance}")
        fields = model_to_dict(instance)
        meta_fields = Model._meta.get_fields()
        verbose_names = {}
        field_types = {}

        for field in meta_fields:
            if hasattr(field, 'name'):  
                verbose_names[field.name] = field.verbose_name
                field_types[field.name] = type(field).__name__

        return {"fields": fields, "verbose": verbose_names, "types": field_types}
    except Exception as e:
        print(f"An error occurred: {e}")
        return {}

@database_sync_to_async
def get_verbose_dict(model_str):
  return get_verbose_dict_sync(model_str)

@database_sync_to_async
def get_users_dict():
    users = User.objects.all()
    users_dict = [
        model_to_dict(user)
        for user in users
    ]

    return users_dict

@database_sync_to_async
def get_users_list():
    users = User.objects.values_list('username', flat=True)
    return list(users)

@database_sync_to_async
def add_user(info):
    new_user, created = User.objects.get_or_create(username=info.get("username", None))
    if not created:
        return False

    for k, v in info.items():
        if k in ["id", "discord_servers", "added", "requests", "username"]:
            continue
        if hasattr(new_user, k):
            setattr(new_user, k, v)

    new_user.save()

    for server in info.get("servers", []):
        new_server, _ = DiscordServer.objects.get_or_create(
            server_name=server["server_name"], server_id=server["server_id"]
        )
        
        if new_user not in new_server.users.all():
            new_server.users.add(new_user)
    
    return True

@database_sync_to_async
def add_edit_user(info):
    new_user, created = User.objects.get_or_create(username=info.get("username", None))

    for k, v in info.items():
        if k in ["id", "servers", "added", "requests", "username"]:
            continue
        if hasattr(new_user, k):
            setattr(new_user, k, v)

    new_user.save()

    for server in info.get("servers", []):
        new_server, _ = DiscordServer.objects.get_or_create(
            server_name=server["server_name"], server_id=server["server_id"]
        )
        
        # This checks if the user is already related to the server and adds if not
        if not new_server.users.filter(id=new_user.id).exists():
            new_server.users.add(new_user)
    
    return True

@database_sync_to_async
def get_discord_server_from_id(server_id):
    return DiscordServer.objects.filter(server_id=server_id).first()

@database_sync_to_async
def delete_user(id):
    if not id:
        return None
    try:
        user = User.objects.get(id=id)
        username = user.username
        user.delete()
        return username
    except ObjectDoesNotExist:
        return None

@database_sync_to_async
def get_user_from_id(id):
    # if id == 'undefined':
    #     user = User.objects.first()
    #     user.delete()
    #     return
    user = User.objects.filter(id=id).first()
    if user:
        return model_to_dict(user)
    return None

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
        server, created = DiscordServer.objects.get_or_create(server_id=server_data["server_id"])
        server.server_name = server_data["server_name"]
        server.save()
        server.users.add(user)
    
    return changes_made

@database_sync_to_async
def get_all_user_servers(username):
    servers = DiscordServer.objects.all()
    try:
      user = User.objects.get(username=username)
    except User.DoesNotExist:
      print('USER DOES NOT EXIST (get_all_user_servers)')
      return []
    user_servers = []

    for server in servers:
        server_dict = model_to_dict(server)
        server_dict["active"] = user in server.users.all()
        user_servers.append(server_dict)

    return user_servers

@database_sync_to_async
def update_servers(servers):
    server_ids = [s["server_id"] for s in servers]
    DiscordServer.objects.exclude(server_id__in=server_ids).delete()

    for server in servers:
        new_server, created = DiscordServer.objects.update_or_create(
            server_id=server["server_id"], 
            defaults={'server_name': server["server_name"]}
        )

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
    call_command('flush', '--noinput')

    # Create default State and Configuration if needed
    if not State.objects.exists():
        State.objects.create()
    if not Configuration.objects.exists():
        Configuration.objects.create()

def export_data(choices):
    """
    Exports data from specified models to a JSON file.
    """
    # List of models to dump data from
    models_to_dump = []
    if choices["Configuration"]:
        models_to_dump.append('DiscoFlixClient.Configuration')
    if choices["EventLog"]:
        models_to_dump.append('DiscoFlixClient.EventLog')
        models_to_dump.append('DiscoFlixClient.ErrLog')
    if choices["User"]:
        models_to_dump.append('DiscoFlixClient.User')
        models_to_dump.append('DiscoFlixClient.DiscordServer')
        models_to_dump.append('DiscoFlixClient.MediaRequest')
        models_to_dump.append('DiscoFlixClient.Media')
        
    file_path = os.path.join(settings.BACKUPS_DIR, 'DiscoDB.json')
    call_command('dumpdata', *models_to_dump, output=file_path, format='json')
    return file_path

@database_sync_to_async
def import_data(choices, file_path):
    """
    Imports data from a JSON file into specified models. Choices currently disabled.
    """

    call_command('loaddata', file_path)

    if not State.objects.exists():
        State.objects.create()
    if not Configuration.objects.exists():
        Configuration.objects.create()
