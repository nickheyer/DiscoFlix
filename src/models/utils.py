from pathlib import Path

from playhouse.shortcuts import (
    model_to_dict,
    dict_to_model
)

from models.models import (
    Configuration,
    State,
    ErrLog,
    EventLog,
    MediaRequest,
    User,
    Media,
    DiscordServer,
    DiscordServerUsers
)

def get_config():
    return Configuration.get()

def get_config_dict():
    return model_to_dict(Configuration.get())

def update_config(data):
    config = Configuration.get()
    changed = []
    if data:
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
        user['added'] = user['added'].isoformat()
    return users_dict

def get_users_list():
    users = User.select(User.username)
    return [user.username for user in users]

def add_user(info):
    new_user, created = User.get_or_create(username=info.get('username', None))
    if not created:
        return False
    new_user.is_admin = info.get('is_admin', False)
    new_user.is_server_restricted = info.get('is_server_restricted', False)
    new_user.save()
    for server in info.get('servers', []):
        new_server,_ = DiscordServer.get_or_create(
            server_name=server['server_name'],
            server_id=server['server_id'])
        if new_user not in new_server.users:
            new_server.users.add(new_user)
    return True

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
    user_dict['added'] = user_dict['added'].isoformat()
    return user_dict

def edit_user_from_dict(data):
    username = data.get('username', None)
    user_id = data.get('id', None)
    if not id:
        return None
    if user_id not in ['', None]:
        user = User.get_or_none(id=user_id)
    else:
        user = User.get_or_none(username=username)
    if not user:
        return None
    user.username = username
    user.is_admin = data.get('is_admin', False)
    user.is_server_restricted = data.get('is_server_restricted', False)
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
    return True

def get_all_user_servers(username):
    servers = DiscordServer.select()
    user = User.get_or_none(username=username)
    user_servers = []
    for server in servers:
        server_dict = model_to_dict(server)
        server_dict['active'] = user and server in user.discord_servers
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