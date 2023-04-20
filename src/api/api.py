from flask import Blueprint, request, jsonify
from playhouse.shortcuts import model_to_dict, DoesNotExist

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
