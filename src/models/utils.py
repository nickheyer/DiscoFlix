from pathlib import Path
import json
import datetime
import os
from dateutil.parser import parse

from playhouse.shortcuts import (
    model_to_dict,
    dict_to_model
)

from peewee import DateTimeField

from lib.utils import get_data_path

from models.models import (
    Configuration,
    State,
    ErrLog,
    EventLog,
    MediaRequest,
    User,
    Media,
    DiscordServer,
    DiscordServerUsers,
    db,
    UserRequests
)

def get_config():
    return Configuration.get()

def get_config_dict():
    return model_to_dict(Configuration.get())

def sanitize_urls(config):
    if config.radarr_url:   
        if config.radarr_url.endswith('/'):
            config.radarr_url = config.radarr_url[:-1]
        if config.radarr_url[0].isdigit():
            config.radarr_url = 'http://' + config.radarr_url
    if config.sonarr_url:
        if config.sonarr_url.endswith('/'):
            config.sonarr_url = config.sonarr_url[:-1]
        if config.sonarr_url[0].isdigit():
            config.sonarr_url = 'http://' + config.sonarr_url

def update_config(data):
    config = Configuration.get()
    changed = []
    
    if data:
        print(data)
        for k, v in data.items():
            if hasattr(config, k):
                attribute = getattr(config, k)
                if str(attribute) != str(v):
                    changed.append(k)
                setattr(config, k, v)
    sanitize_urls(config)
    config.save()
    config_dict = model_to_dict(config)
    config_dict['changed'] = changed
    return config_dict

def update_state(data):
    state = State.get()
    if data:
        for k, v in data.items():
            if hasattr(state, k):
                setattr(state, k, v)
    state.save()
    return model_to_dict(state)

def get_logs(num):
    return [f"{row.created}: {row.entry}" for row in EventLog.select()
    .order_by(EventLog.created.desc())
    .limit(num)][::-1]

def add_log(entry):
    EventLog.create(entry = entry)

def get_dict(model_str):
    Model = globals()[model_str]
    if Model:
        model_dict = model_to_dict(Model.get())
        return model_dict
    else:
        return {}

def get_verbose_dict(model_str):
    Model = globals()[model_str]
    if Model:
        fields = model_to_dict(Model.get())
        meta_fields = Model._meta.sorted_fields

        verbose_names = dict()
        field_types = dict()
        
        for field in meta_fields:
            verbose_names[field.name] = field.verbose_name
            field_types[field.name] = field.field_type

        return {
            'fields': fields,
            'verbose': verbose_names,
            'types': field_types
        }
    else:
        return {}

def get_users_dict():
    users = User.select()
    users_dict = [model_to_dict(
        user,
        backrefs=True,
        recurse=True,
        manytomany=True,
        max_depth=1,
        exclude=['id'])
        for user in users]
    
    for user in users_dict:
        user['added'] = user['added'].strftime("%H:%M:%S %m/%d/%Y")
    return users_dict

def get_users_list():
    users = User.select(User.username)
    return [user.username for user in users]

def add_user(info):
    new_user, created = User.get_or_create(username=info.get('username', None))
    if not created:
        return False
    for k, v in info.items():
        if k in ['id', 'discord_servers', 'added', 'requests', 'username']:
            continue
        if hasattr(new_user, k):
            setattr(new_user, k, v)
    new_user.save()
    for server in info.get('servers', []):
        new_server,_ = DiscordServer.get_or_create(
            server_name=server['server_name'],
            server_id=server['server_id'])
        if new_user not in new_server.users:
            new_server.users.add(new_user)
    return True

def add_edit_user(info):
    new_user, created = User.get_or_create(username=info.get('username', None))
    for k, v in info.items():
        if k in ['id', 'servers', 'added', 'requests', 'username']:
            continue
        if hasattr(new_user, k):
            setattr(new_user, k, v)
    new_user.save()
    for server in info.get('servers', []):
        new_server,_ = DiscordServer.get_or_create(
            server_name=server['server_name'],
            server_id=server['server_id'])
        if new_user not in new_server.users:
            new_server.users.add(new_user)
    return True

def get_discord_server_from_id(server_id):
    return DiscordServer.get_or_none(server_id=server_id)

def delete_user(id):
    if not id:
        return None
    user = User.get_or_none(id=id)
    if not user:
        return None
    username = user.username
    user.delete_instance()
    return username

def get_user_from_id(id):
    if not id:
        return None
    user = User.get_or_none(id=id)
    if not user:
        return None
    user_dict = model_to_dict(
        user,
        backrefs=True,
        recurse=True,
        manytomany=True,
        max_depth=1)
    user_dict['added'] = user_dict['added'].strftime("%H:%M:%S %m/%d/%Y")
    return user_dict

def edit_user_from_dict(data):
    username = data.get('username', None)
    user_id = data.get('id', None)
    user = None
    if user_id:
        user = User.get_or_none(id=user_id)
    elif username:
        user = User.get_or_none(username=username)
    if not user:
        return None
    user.username = username
    changes_made = []
    for k, v in data.items():
        if hasattr(user, k):
            data_in_model = getattr(user, k)
            if data_in_model != type(data_in_model)(v):
                changes_made.append(k)
            if k not in ['id', 'discord_servers', 'added', 'requests', 'username']:
                setattr(user, k, v)
        
    user.save()
    server_list = data.get('servers', [])
    for server in user.discord_servers:
        if server.server_id not in list(map(lambda x: x.get('server_id', None), server_list)):
            server.users.remove(user)
    for server in server_list:
        new_server, created = DiscordServer.get_or_create(
            server_id=server['server_id'])
        new_server.server_name = server['server_name']
        new_server.save()
        if user not in new_server.users:
            new_server.users.add(user)
    return changes_made

def get_all_user_servers(username):
    servers = DiscordServer.select()
    user = User.get_or_none(username=username)
    user_servers = []
    for server in servers:
        server_dict = model_to_dict(server)
        server_dict['active'] = False if not user else server in user.discord_servers
        user_servers.append(server_dict)
    return user_servers

def update_servers(servers):
    current = DiscordServer.select()
    server_ids = [s['server_id'] for s in servers]
    for server in current:
        if server.server_id not in server_ids:
            server.delete_instance()
    for server in servers:
        new_server, created = DiscordServer.get_or_create(
            server_id = server['server_id'])
        new_server.server_name = server['server_name']
        new_server.save()

def get_required_fields():
    fields = [
        'media_server_name',
        'prefix_keyword',
        'discord_token',
    ]
    config = Configuration.get()
    if config.is_radarr_enabled:
        fields.extend([
            'radarr_url',
            'radarr_token'
        ])
    if config.is_sonarr_enabled:
        fields.extend([
            'sonarr_url',
            'sonarr_token'
        ])
    return fields

class DateTimeEncoderToJson(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime.datetime):
            return obj.isoformat()
        return super(DateTimeEncoderToJson, self).default(obj)
    
def reset_database(choices):
    tables_to_reset = [State]
    if choices['Configuration']:
        tables_to_reset.append(Configuration)
    if choices['EventLog']:
        tables_to_reset.append(EventLog)
        tables_to_reset.append(ErrLog)
    if choices['User']:
        tables_to_reset.append(User)
        tables_to_reset.append(DiscordServer)
        tables_to_reset.append(DiscordServerUsers) 
        tables_to_reset.append(UserRequests)
        tables_to_reset.append(MediaRequest)
        tables_to_reset.append(Media)
    db.drop_tables(tables_to_reset)
    db.create_tables(tables_to_reset, safe=True)

def reset_entire_db():
    tables_to_reset = [
        Configuration,
        State,
        ErrLog,
        EventLog,
        User,
        DiscordServer,
        DiscordServerUsers,
        UserRequests,
        MediaRequest,
        Media
    ]
    db.drop_tables(tables_to_reset)
    db.create_tables(tables_to_reset, safe=True)
    if not State.select().exists():
        State.create()
    if not Configuration.select().exists():
        Configuration.create()

def export_model_data(model):
    query = model.select()
    data = [model_to_dict(item, max_depth=0) for item in query]
    return data

def import_model_data(model, data):
    instances = []
    for item in data:
        for field_name, field_value in item.items():
            field = model._meta.fields.get(field_name)
            if isinstance(field, DateTimeField) and isinstance(field_value, str):
                item[field_name] = parse(field_value)
        instance = dict_to_model(model, item, ignore_unknown=True)
        instances.append(instance)
    with db.atomic():
        model.bulk_create(instances)

def import_data_from_file(choices, data):
    if choices['Configuration']:
        import_model_data(Configuration, data['Configuration'])
    if choices['EventLog']:
        import_model_data(EventLog, data['EventLog'])
        import_model_data(ErrLog, data['ErrLog'])
    if choices['User']:
        import_model_data(DiscordServerUsers, data['DiscordServerUsers'])
        import_model_data(UserRequests, data['UserRequests'])
        import_model_data(DiscordServer, data['DiscordServer'])
        import_model_data(MediaRequest, data['MediaRequest'])
        import_model_data(Media, data['Media'])
        import_model_data(User, data['User'])
        



def export_data_to_file(choices):
    data = {}
    if choices['Configuration']:
        data['Configuration'] = export_model_data(Configuration)
    if choices['EventLog']:
        data['EventLog'] = export_model_data(EventLog)
        data['ErrLog'] = export_model_data(ErrLog)
    if choices['User']:
        data['User'] = export_model_data(User)
        data['DiscordServer'] = export_model_data(DiscordServer)
        data['DiscordServerUsers'] = export_model_data(DiscordServerUsers) 
        data['UserRequests'] = export_model_data(UserRequests)
        data['MediaRequest'] = export_model_data(MediaRequest)
        data['Media'] = export_model_data(Media)
    return data


def export_data(choices):
    data = export_data_to_file(choices)
    file_path = os.path.join(get_data_path(), 'DiscoDB.json')
    with open(file_path, 'w') as fp:
        json.dump(data, fp, cls=DateTimeEncoderToJson)
    return file_path

def import_data(choices, file_path):
    reset_database(choices)
    with open(file_path, 'r') as fp:
        data = json.load(fp)
    import_data_from_file(choices, data)
    if not State.select().exists():
        State.create()
    if not Configuration.select().exists():
        Configuration.create()