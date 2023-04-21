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

    users = [model_to_dict(user) for user in query]
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
        else:
            return jsonify({"error": f"Invalid field '{key}' in query parameters"}), 400

    if query:
        user = model_to_dict(query[0])
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

