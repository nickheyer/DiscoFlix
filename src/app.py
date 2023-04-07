import gevent
from gevent import monkey
monkey.patch_all()
import sys, os
import requests
from flask import Flask, render_template, request
from flask_socketio import SocketIO
import atexit
import signal
import json

from models.utils import (
    update_config,
    update_state,
    get_logs,
    get_dict,
    get_verbose_dict,
    add_log,
    get_users_dict,
    get_users_list,
    add_user,
    add_edit_user,
    delete_user,
    get_user_from_id,
    edit_user_from_dict,
    get_all_user_servers,
    update_servers,
    get_required_fields,
    import_data,
    export_data,
    reset_entire_db
)

from lib.utils import initialize_dirs, get_data_path

from bot.bot_controller import (
    start_bot,
    kill_bot,
    kill_all_bots
)

from models.models import initialize_db

# --- FLASK/SOCKET INSTANTIATION

app = Flask(__name__)
socketio = SocketIO(app)
app.config["TEMPLATES_AUTO_RELOAD"] = True


# --- MISC HELPERS ---

def refresh_logs():
    socketio.emit('bot_log_added', {
        'log': get_logs(100)
    })

def add_refresh_log(log):
    add_log(log)
    refresh_logs()

def check_for_null(data):
    nulls = []
    required = get_required_fields()
    for k, v in data.items():
        if not v and k in required:
            nulls.append(k)
    return nulls

def validate_disc_token(token):
    response = requests.get(
        'https://discord.com/api/v9/users/@me',
        headers={'Authorization': f'Bot {token}'})
    return response.status_code == 200

def turn_bot_on(bot_name):
    bot_state = get_dict('State')[f'{bot_name}_state']
    config = get_dict('Configuration')
    try:
        if bot_state:
            raise Exception("Bot already on!")
        null_fields = check_for_null(config)
        if len(null_fields) > 0:
            return {
                'success': False,
                'error': f'Missing required configuration fields: {", ".join(null_fields)}',
                'bot_name': bot_name
            }
        if bot_name == 'discord':
            if not validate_disc_token(config['discord_token']):
                return {
                    'success': False,
                    'error': 'Invalid Discord Token',
                    'bot_name': bot_name
                }
        start_bot(bot_name, request.host, config[f'{bot_name}_token'])
        return {
            'success': True,
            'bot_name': bot_name
        }
    except Exception as e:
        socketio.emit('bot_on_finished', {
                    'success': False,
                    'error': f'{e} - line 100 in app',
                    'bot_name': bot_name
                })

# --- STARTUP ---

@app.before_first_request
def startup():
    initialize_dirs()
    initialize_db()
    add_refresh_log('Server started!')
    update_state({
        'app_state': True,
        'current_activity': 'Offline'
    })

# --- SHUTDOWN ---

def shutdown_server():
    kill_all_bots()
    if sys.platform in ["linux", "linux2"]:
        os.system("pkill -f gunicorn")
    try:
        request.environ.get("werkzeug.server.shutdown")()
    except:
        pass
    sys.exit()

@atexit.register
def exit_shutdown():
    add_refresh_log('Server killed!')
    update_state({
        'discord_state': False,
        'app_state': False
    })
    kill_all_bots()

# --- HTTP ROUTES ---

@app.route("/")
def index():
    return render_template("/index.html")

# --- WEBSOCKET ROUTES ---

# - CLIENT SOCKETS

@socketio.on('client_connect')
def socket_on_connect(data):
    socketio.emit('client_info', {
        'config': get_verbose_dict('Configuration'),
        'state': get_dict('State'),
        'log': get_logs(100),
        'users': get_users_dict()
    })

@socketio.on('get_config')
def socket_get_config(data):
    config =  get_dict('Configuration')
    socketio.emit('config', config)

@socketio.on('update_config')
def socket_update_config(data):
    config = update_config(data)
    if len(config.get('changed', [])) > 0:
        updated_configs = ', '.join(config['changed'])
        add_refresh_log(f'Configuration updated: {updated_configs}')
    socketio.emit('config_updated', config)

@socketio.on('server_off')
def socket_turn_server_off(data):
    gevent.spawn(shutdown_server)

@socketio.on('bot_on')
def socket_turn_bot_on(data):
    return turn_bot_on(data['bot_name'])

@socketio.on('bot_off')
def socket_turn_bot_on(data):
    bot_name = data['bot_name']
    bot_state = get_dict('State')[f'{bot_name}_state']
    try:
        if not bot_state:
            raise Exception("Bot already off!")
        kill_bot(bot_name)
        socketio.emit('bot_off_finished', { 'success': True, 'bot_name': bot_name})
        update_state({
            f'{bot_name}_state': False
        })
        add_refresh_log(f'{bot_name.title()}-bot killed!')
        refresh_logs()
    except Exception as e:
        socketio.emit('bot_off_finished', { 'error': str(e), 'bot_name': bot_name})

# - BOT SOCKETS

@socketio.on('bot_started')
def socket_bot_started(data):
    # Forwarding the emit to the client from bot subproc
    bot_name = data["bot_name"]
    socketio.emit('bot_on_finished', data)
    update_state({
        f'{bot_name}_state': True
    })
    add_refresh_log(f'{bot_name.title()}-bot started!')

@socketio.on('change_client_status')
def socket_bot_change_presence(data):
    status = {
        'current_activity': data['status']
    }
    update_state(status)
    socketio.emit('update_status', status)

@socketio.on('bot_add_log')
def socket_bot_log_added(data):
    add_refresh_log(data['log'])

@socketio.on('get_unadded_users')
def socket_bot_get_unadded_users(data):
    socketio.emit('get_unadded_users_from_bot', {
        'users': get_users_list()
    })

@socketio.on('unadded_users_from_bot')
def socket_bot_send_unadded_users(data):
    socketio.emit('unadded_users_sent', data)

@socketio.on('add_user_from_client')
def socket_bot_add_user_from_client(data):
    added = add_user(data['user_info'])
    if not added:
        return {
            'username': data['user_info'],
            'error': 'User already exists!'
        }
    socketio.emit('users_updated', { 'users': get_users_dict() })
    add_refresh_log(f'User Added: {data["user_info"].get("username", "Invalid User")}')
    return {
        'username': data['user_info'],
        'success': 'User added.'
    }

@socketio.on('add_edit_user')
def socket_bot_add_edit_user_from_client(data):
    added = add_edit_user(data['user_info'])
    if not added:
        return {
            'username': data['user_info'],
            'error': 'User already exists!'
        }
    socketio.emit('users_updated', { 'users': get_users_dict() })
    return {
        'username': data['user_info'],
        'success': 'User added.'
    }

@socketio.on('edit_user_from_client')
def socket_bot_edit_user_from_client(data):
    edited = edit_user_from_dict(data['user_info'])
    if not edited:
        return {
            'username': data['user_info'],
            'error': 'Nothing changed!'
        }
    socketio.emit('users_updated', { 'users': get_users_dict() })
    add_refresh_log(f'User Updated: {data["user_info"].get("username", "Invalid User")} ({", ".join(edited)})')
    return {
        'username': data['user_info'],
        'success': 'User edited.'
    }

@socketio.on('request_servers_from_client')
def socket_request_servers_from_client(data):
    server_list = get_all_user_servers(data.get('username'))
    return { 'servers': server_list }

@socketio.on('all_servers_from_bot')
def socket_all_servers_from_bot(data):
    update_servers(data['servers'])

@socketio.on('get_user_info_from_id')
def socket_get_user_info_from_id(data):
    return get_user_from_id(data.get('id', None))

@socketio.on('delete_user')
def socket_get_user_info_from_id(data):
    deleted = delete_user(data['user_id'])
    if not deleted:
        return {
            'username': data['user_id'],
            'error': 'Unable to delete user'
        }
    socketio.emit('users_updated', { 'users': get_users_dict() })
    add_refresh_log(f'User Deleted: {deleted}')
    return {
        'username': data['user_id'],
        'success': 'User deleted.'
    }

@socketio.on('import_export_from_client')
def socket_import_export_db(data):
    action = data['action']
    choices = data['choices']
    if action == 'import':
        kill_all_bots()
        file_path = os.path.join(get_data_path(), 'DiscoDB.json')
        try:
            with open(file_path, 'w') as fp:
                json.dump(json.loads(data['data']), fp)
        except Exception as e:
            return { 'err': str(e) } 
        import_data(choices, file_path)
        return { 'import_success': True } 
    elif action == 'export':
        try:
            file_path = export_data(choices)
            if not file_path:
                return
            with open(file_path, 'rb') as fp:
                content = fp.read()
                socketio.emit('exported_backup_file', content, binary=True)
        except Exception as e:
            return { 'err': str(e) }
        return { 'import_success': True } 
    return { 'nothing_happened': True } 

@socketio.on('reset_db_from_client')
def socket_reset_db(data):
    kill_all_bots()
    try:
        reset_entire_db()
    except Exception as e:
        return { 'err': str(e) }
    return { 'reset_success': True }

# --- SOCKET/FLASK APP LOOP ---

if __name__ == "__main__":
    socketio.run(app)
