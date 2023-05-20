from flask import Blueprint, request, jsonify
from playhouse.shortcuts import model_to_dict, DoesNotExist, BooleanField

from models.models import (
    Configuration,
    ErrLog,
    EventLog,
    User,
    DiscordServer,
    DiscordServerUsers,
    UserRequests,
    MediaRequest,
    Media,
)

rest = Blueprint('rest_api', __name__, url_prefix='/api')


# --- TEST API (GET) ---

@rest.route('/test', methods=['POST', 'GET', 'PUT', 'DELETE'])
def test_route():
    return 'it works!', 200

# --- CONFIGURATION (GET, UPDATE) ---

@rest.route('/configuration', methods=['GET'])
def get_configuration():
    config = Configuration.get()
    return jsonify(model_to_dict(config)), 200

@rest.route('/configuration', methods=['PUT'])
def update_configuration():
    config = Configuration.get()
    data = request.get_json()

    for field, value in data.items():
        if hasattr(config, field):
            setattr(config, field, value)

    config.save()
    return jsonify(model_to_dict(config)), 200

# --- ERROR LOGS (GET) ---

@rest.route('/errors', methods=['GET'])
def get_error_logs():
    error_logs = [model_to_dict(log) for log in ErrLog.select()]
    return jsonify(error_logs), 200

# --- EVENT LOGS (GET, CREATE, DELETE, UPDATE) ---

@rest.route('/logs', methods=['GET'])
def get_event_logs():
    event_logs = [model_to_dict(log) for log in EventLog.select()]
    return jsonify(event_logs), 200

@rest.route('/logs', methods=['POST'])
def create_event_log():
    data = request.get_json()
    event_log = EventLog.create(entry=data['entry'])
    return jsonify(model_to_dict(event_log)), 201

@rest.route('/logs/<int:event_log_id>', methods=['PUT'])
def update_event_log(event_log_id):
    try:
        event_log = EventLog.get(EventLog.id == event_log_id)
        data = request.get_json()

        if 'entry' in data:
            event_log.entry = data['entry']

        event_log.save()
        return jsonify(model_to_dict(event_log)), 200
    except DoesNotExist:
        return jsonify({"error": "Event log not found"}), 404

@rest.route('/logs/<int:event_log_id>', methods=['DELETE'])
def delete_event_log(event_log_id):
    try:
        event_log = EventLog.get(EventLog.id == event_log_id)
        event_log.delete_instance()
        return jsonify({"result": "Event log deleted"}), 200
    except DoesNotExist:
        return jsonify({"error": "Event log not found"}), 404

# --- USER(S) (GET, CREATE, DELETE, UPDATE) ---

@rest.route('/users', methods=['GET'])
def get_users():
    query_params = request.args
    query = User.select()

    for key, value in query_params.items():
        if hasattr(User, key):
            field = getattr(User, key)
            # Converting boolean fields to their intended bool value
            if isinstance(field, BooleanField):
                if value.lower() in ['true', '1']:
                    value = True
                elif value.lower() in ['false', '0']:
                    value = False
                else:
                    return jsonify({"error": f"Invalid boolean value '{value}' for field '{key}'"}), 400
            query = query.where(field == value)
        else:
            return jsonify({"error": f"Invalid field '{key}' in query parameters"}), 400
    
    if not query_params.get('recursive', False):
        users = [model_to_dict(user) for user in query]
    else:
        users = [model_to_dict(user, backrefs=True, recurse=True) for user in query]
    
    return jsonify(users), 200

@rest.route('/user', methods=['GET'])
def get_user():
    query_params = request.args
    query = User.select()

    for key, value in query_params.items():
        if hasattr(User, key):
            field = getattr(User, key)
            if isinstance(field, BooleanField):
                if value.lower() in ['true', '1']:
                    value = True
                elif value.lower() in ['false', '0']:
                    value = False
                else:
                    return jsonify({"error": f"Invalid boolean value '{value}' for field '{key}'"}), 400

            query = query.where(field == value)

    if query and not query_params.get('recursive', False):
        user = model_to_dict(query[0])
    elif query:
        user = model_to_dict(query[0], backrefs=True, recurse=True)
    else:
        return jsonify({"error": f"No user found that matches these parameters"}), 400
    return jsonify(user), 200

@rest.route('/user', methods=['POST'])
def create_user():
    data = request.get_json()
    discord_server = None
    if 'discord_server_id' in data:
        try:
            discord_server = DiscordServer.get(DiscordServer.id == data['discord_server_id'])
        except DiscordServer.DoesNotExist:
            return jsonify({"error": f"Discord server with ID '{data['discord_server_id']}' not found"}), 404
        del data['discord_server_id']

    new_user = User.create(**data)
    if discord_server:  
        new_user.discord_servers.add(discord_server)
    new_user.save()

    return jsonify(model_to_dict(new_user)), 201

@rest.route('/user/<int:user_id>', methods=['PUT'])
def update_user(user_id):
    data = request.get_json()

    try:
        user_to_update = User.get(User.id == user_id)
    except User.DoesNotExist:
        return jsonify({"error": f"User with ID '{user_id}' not found"}), 404

    discord_server = None
    if 'discord_server_id' in data:
        try:
            discord_server = DiscordServer.get(DiscordServer.id == data['discord_server_id'])
        except DiscordServer.DoesNotExist:
            return jsonify({"error": f"Discord server with ID '{data['discord_server_id']}' not found"}), 404
        del data['discord_server_id']

    for key, value in data.items():
        setattr(user_to_update, key, value)

    if discord_server:
        if discord_server not in user_to_update.discord_servers:
            user_to_update.discord_servers.add(discord_server)
        else:
            return jsonify({"error": f"User already exists within Discord Server: '{discord_server.server_name}' (ID: {discord_server.id})"}), 400

    user_to_update.save()
    return jsonify(model_to_dict(user_to_update)), 200

@rest.route('/user/<int:user_id>', methods=['DELETE'])
def delete_user(user_id):
    try:
        user = User.get_by_id(user_id)
    except User.DoesNotExist:
        return jsonify({"error": f"User with ID '{user_id}' not found"}), 404
    user.delete_instance()
    return jsonify({"message": f"User with ID {user_id} has been deleted."}), 200

# --- DISCORD SERVERS(S) (GET, CREATE, DELETE, UPDATE) ---

@rest.route('/server', methods=['GET'])
def get_server():
    query_params = request.args
    query = DiscordServer.select()
    for key, value in query_params.items():
        if hasattr(DiscordServer, key):
            field = getattr(DiscordServer, key)
            if isinstance(field, BooleanField):
                if value.lower() in ['true', '1']:
                    value = True
                elif value.lower() in ['false', '0']:
                    value = False
                else:
                    return jsonify({"error": f"Invalid boolean value '{value}' for field '{key}'"}), 400

            query = query.where(field == value)

    if query and not query_params.get('recursive', False):
        server = model_to_dict(query[0])
    elif query:
        server = model_to_dict(query[0], backrefs=True, recurse=True)
    else:
        return jsonify({"error": f"No server found that matches these parameters"}), 400
    return jsonify(server), 200

@rest.route('/servers', methods=['GET'])
def get_servers():
    query_params = request.args
    query = DiscordServer.select()
    for key, value in query_params.items():
        if hasattr(DiscordServer, key):
            field = getattr(DiscordServer, key)
            if isinstance(field, BooleanField):
                if value.lower() in ['true', '1']:
                    value = True
                elif value.lower() in ['false', '0']:
                    value = False
                else:
                    return jsonify({"error": f"Invalid boolean value '{value}' for field '{key}'"}), 400

            query = query.where(field == value)

    if query and not query_params.get('recursive', False):
        server = [model_to_dict(server) for server in query]
    elif query:
        server = [model_to_dict(server, backrefs=True, recurse=True) for server in query]
    else:
        return jsonify({"error": f"No server found that matches these parameters"}), 400
    return jsonify(server), 200

@rest.route('/server', methods=['POST'])
def create_server():
    data = request.get_json()
    new_server= DiscordServer.create(**data)
    new_server.save()
    return jsonify(model_to_dict(new_server)), 201

@rest.route('/server/<int:server_id>', methods=['PUT'])
def update_server(server_id):
    data = request.get_json()
    try:
        server_to_update = DiscordServer.get(DiscordServer.id == server_id)
    except DiscordServer.DoesNotExist:
        return jsonify({"error": f"Server with ID '{server_id}' not found"}), 404
    for key, value in data.items():
        setattr(server_to_update, key, value)
    server_to_update.save()
    return jsonify(model_to_dict(server_to_update)), 200

@rest.route('/server/<int:server_id>', methods=['DELETE'])
def delete_server(server_id):
    try:
        server = DiscordServer.get_by_id(server_id)
    except DiscordServer.DoesNotExist:
        return jsonify({"error": f"Server with ID '{server_id}' not found"}), 404
    server.delete_instance()
    return jsonify({"message": f"Server with ID {server_id} has been deleted."}), 200

# --- MEDIA (GET, CREATE, DELETE, UPDATE) ---

@rest.route('/media', methods=['GET'])
def get_media():
    query_params = request.args
    query = Media.select()

    for key, value in query_params.items():
        if hasattr(Media, key):
            field = getattr(Media, key)
            # Converting boolean fields to their intended bool value
            if isinstance(field, BooleanField):
                if value.lower() in ['true', '1']:
                    value = True
                elif value.lower() in ['false', '0']:
                    value = False
                else:
                    return jsonify({"error": f"Invalid boolean value '{value}' for field '{key}'"}), 400
            query = query.where(field == value)
    
    if not query_params.get('recursive', False):
        media_content = [model_to_dict(media) for media in query]
    else:
        media_content = [model_to_dict(media, backrefs=True, recurse=True) for media in query]
    
    return jsonify(media_content), 200

@rest.route('/media', methods=['POST'])
def create_media():
    data = request.get_json()

    new_media = Media.create(**data)
    new_media.save()

    return jsonify(model_to_dict(new_media)), 201

@rest.route('/media/<int:media_id>', methods=['PUT'])
def update_media(media_id):
    data = request.get_json()

    try:
        media_to_update = Media.get(Media.id == media_id)
    except Media.DoesNotExist:
        return jsonify({"error": f"Media with ID '{media_id}' not found"}), 404

    for key, value in data.items():
        setattr(media_to_update, key, value)

    media_to_update.save()
    return jsonify(model_to_dict(media_to_update)), 200

@rest.route('/media/<int:media_id>', methods=['DELETE'])
def delete_media(media_id):
    try:
        media = Media.get_by_id(media_id)
    except Media.DoesNotExist:
        return jsonify({"error": f"Media with ID '{media_id}' not found"}), 404
    media.delete_instance()
    return jsonify({"message": f"Media with ID {media_id} has been deleted."}), 200

# --- REQUESTS (GET, CREATE, DELETE, UPDATE) ---

@rest.route('/request', methods=['GET'])
def get_requests():
    query_params = request.args
    query = MediaRequest.select()

    for key, value in query_params.items():
        if hasattr(MediaRequest, key):
            field = getattr(MediaRequest, key)
            # Converting boolean fields to their intended bool value
            if isinstance(field, BooleanField):
                if value.lower() in ['true', '1']:
                    value = True
                elif value.lower() in ['false', '0']:
                    value = False
                else:
                    return jsonify({"error": f"Invalid boolean value '{value}' for field '{key}'"}), 400
            query = query.where(field == value)
    
    if not query_params.get('recursive', False):
        media_requests = [model_to_dict(media) for media in query]
    else:
        media_requests = [model_to_dict(media, backrefs=True, recurse=True) for media in query]
    
    return jsonify(media_requests), 200

@rest.route('/request', methods=['POST'])
def create_request():
    data = request.get_json()

    new_req = MediaRequest.create(**data)
    new_req.save()

    return jsonify(model_to_dict(new_req)), 201

@rest.route('/request/<int:request_id>', methods=['PUT'])
def update_request(request_id):
    data = request.get_json()

    try:
        request_to_update = MediaRequest.get(MediaRequest.id == request_id)
    except MediaRequest.DoesNotExist:
        return jsonify({"error": f"Request with ID '{request_id}' not found"}), 404

    for key, value in data.items():
        setattr(request_to_update, key, value)

    request_to_update.save()
    return jsonify(model_to_dict(request_to_update)), 200

@rest.route('/request/<int:request_id>', methods=['DELETE'])
def delete_request(request_id):
    try:
        req = MediaRequest.get_by_id(request_id)
    except MediaRequest.DoesNotExist:
        return jsonify({"error": f"Request with ID '{request_id}' not found"}), 404
    req.delete_instance()
    return jsonify({"message": f"Request with ID {request_id} has been deleted."}), 200
