import os
import sys

# SYSPATH REQUIRES APPENDING AFTER LAUNCHING AS SUBPROC
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import socketio
import discord
import traceback
import argparse

from lib.utils import (
    get_bug_report_path
)
from bot.request_handler import RequestHandler
from bot.message_handler import Message_Handler
from bot.config_manager import config
from bot.user_manager import (
    get_users_in_server,
    get_user_requests_last_24_hours
)
from bot.ui_manager import (
    ApproveNewUser
)

# SUBPROC CMD ARGS
parser = argparse.ArgumentParser()
parser.add_argument('--host', help='the websocket host', required=True)
parser.add_argument('--token', help='discord token', required=True)
args = parser.parse_args()
    
# DECLARING INTENTS (SEE README FOR CONTRIBUTORS)
intents = discord.Intents.all()
intents.members = True

# INSTANTIATING DISCORD CLIENT
client = discord.Client(intents = intents)
embeded = discord.Embed()

# SOCKETIO INSTANTIATION
SIO = socketio.AsyncClient()

# STARTUP FUNCTIONS -----
async def socket_start():
    await SIO.connect(f'http://{args.host}')

async def change_bot_presence(presence):
    await client.change_presence(
        activity=discord.Activity(
        type = discord.ActivityType.watching,
        name = f'& {presence.lower()}'
        ))
    await SIO.emit('change_client_status', {
        'status': presence,
        'bot_name': 'discord'
    })

async def on_startup():
    await socket_start()
    stat = 'listening'
    print(f"Bot is ready to party, logged in as {client.user}. Currently {stat}.")
    await change_bot_presence(stat.title())
    await update_all_servers()
    await SIO.emit('bot_started', {
        'success': True,
        'status': stat,
        'bot_name': 'discord'})
    return

async def update_all_servers():
    servers = [
        { 'server_name': str(guild),
          'server_id': guild.id }
        for guild in client.guilds ]
    await SIO.emit('all_servers_from_bot', {
        'servers': servers
    })

# SOCKET EVENTS -----
@SIO.on('get_unadded_users_from_bot')
async def get_all_users(data):
    unadded = [str(m) for g in client.guilds
    for m in g.members if not m.bot and str(m)
    not in data['users']]
    await SIO.emit('unadded_users_from_bot', { 'unadded': unadded })

@SIO.on('get_servers_for_user')
async def get_user_info(data):
    # Not really being used till TODO (app.py) implemented
    servers = []
    for guild in client.guilds:
        for guild_member in guild.members:
            if not guild_member.bot and str(guild_member) == data['user']:
                servers.append({
                    'server_name': str(guild),
                    'server_id': guild.id
                })
    await SIO.emit('user_servers_from_bot', {
        'user_info': {
            'servers': servers,
            'username': data['user']
        }
    })

# HELPERS/UTILS ------
async def add_log(log_message):
    await SIO.emit('bot_add_log', {
        'log': log_message
    })

async def send_message(message_object, message_to_send, log = False):
    if log:
        await add_log(f'{client.user}: {message_to_send}')
    return await message_object.channel.send(message_to_send)

def get_users_in_server_with(message_object, permissions):
    # Gets all the users (with permissions/roles) usernames in this server from the DB
    users = get_users_in_server(message_object.guild.id, permissions)
    # Converts those usernames into discord user objects
    discord_users = []
    for user in users:
        user = message_object.guild.get_member_named(user)
        if user:
            discord_users.append(user)
    # Returns list of discord member objects
    return discord_users

def generate_mention_users_with(message_object, permissions = []):
    users = get_users_in_server_with(message_object, permissions)
    message_template = ''
    for user in users:
        message_template += f'{user.mention}\n'
    return message_template

async def add_user(message_object, admin=False, restrict_servers=True):
    user_dict = {
        'username': str(message_object.author),
        'is_server_restricted': restrict_servers,
        'is_admin': admin,
        'servers': [
            { 'server_name': str(message_object.guild), 'server_id': message_object.guild.id }
        ]
    }
    await SIO.emit('add_edit_user', { 'user_info': user_dict })

# MESSAGE FUNCTIONS ------
async def _test(m, options):
    await send_message(m, "Testing!")

async def _echo(m, options):
    await send_message(m,
        f"PRIMARY: {options['primary']}\n\n{'EXTRA: ' + options['extra'] if options['extra'] else ''}\n\n{'DEBUG MODE ON' if options['debug'] else ''}"
    )
    if options['debug']:
        await send_message(m, f'```python\n{options["command"]}\n```')

async def _err(m, options):
    await send_message(m, "Let's throw an error!")
    if options['specify']:
        raise Exception(options['specify'])
    else:
        raise Exception('THIS IS AN INTENDED ERROR!')

async def _log(m, options):
    if options['message']:
        await send_message(m, f"Log added!\n```\n{options['primary']}\n```")
    await add_log(options['primary'])

async def _apply(m, options):
    await change_bot_presence(f'Adding Users')
    admins = get_users_in_server_with(m, ['admin'])
    admin_mention = generate_mention_users_with(m, ['admin'])
    response_message = f'User requires registration before requests can be made.\nAdmin approval needed.\n{admin_mention}'
    view = ApproveNewUser(options, m, admins, response_message)
    timeout = await view.send_response()
    if not timeout:
        if view.result in ['DENIED', False, None]:
            return
        await add_user(m, view.result == 'REGISTER_ADMIN')
        await add_log(f'Added User: {m.author} ({view.result})')
    else:
        print('Timed-Out')
    return

async def _find_content(m, options):
    if not get_user_requests_last_24_hours(str(m.author)):
        return
    await change_bot_presence(f'Downloading')
    handler = RequestHandler(options, m, add_log)
    if not await handler.validate_request():
        return False
    return await handler.process_request()

# MESSAGE MAP ------
MESSAGE_MAP = {
    'test': {
            'ref': 'test',
            'permissions': ['admin'],
            'aliases': ['test'],
            'requirements': [],
            'args': {
                'primary': {
                    'required': False,
                    'used': False
                },
                'additional': []
        },
        'fn': _test
    },
    'echo': {
            'ref': 'echo',
            'permissions': ['admin'],
            'aliases': ['echo'],
            'requirements': [],
            'args': {
                'primary': {
                    'required': True,
                    'used': True
                },
                'additional': [
                    { 'ref': 'extra', 'aliases': ('-e', '--extra'), 'required': False, 'expect_content': True },
                    { 'ref': 'debug', 'aliases': ('-d', '--debug'), 'required': False, 'expect_content': False },
                ]

        },
        'fn': _echo
    },
    'error': {
            'ref': 'error',
            'permissions': ['developer'],
            'aliases': ['error', 'err', 'raise'],
            'requirements': [],
            'args': {
                'primary': {
                    'required': False,
                    'used': False
                },
                'additional': [
                    { 'ref': 'specify', 'aliases': ('-s', '--specify'), 'required': False, 'expect_content': True },
                ]

        },
        'fn': _err
    },
    'log': {
            'ref': 'log',
            'permissions': ['admin'],
            'aliases': ['log', 'add-log'],
            'requirements': [],
            'args': {
                'primary': {
                    'required': True,
                    'used': True
                },
                'additional': [
                    { 'ref': 'message', 'aliases': ('-m', '--message'), 'required': False, 'expect_content': False }
                ]
        },
        'fn': _log
    },
    'movie': {
            'ref': 'movie',
            'permissions': ['user'],
            'aliases': ['movie', 'add-movie'],
            'requirements': ['is_radarr_enabled', 'radarr_token', 'radarr_url'],
            'args': {
                'primary': {
                    'required': True,
                    'used': True
                },
                'additional': [
                    { 'ref': 'debug', 'aliases': ('-d', '--debug'), 'required': False, 'expect_content': False }
                ]
        },
        'fn': _find_content,
        'on_reject': _apply
    },
    'show': {
            'ref': 'show',
            'permissions': ['user'],
            'aliases': ['show', 'add-show', 'tv-show', 'add-tv-show', 'tv', 'tvshow'],
            'requirements': ['is_sonarr_enabled', 'sonarr_token', 'sonarr_url'],
            'args': {
                'primary': {
                    'required': True,
                    'used': True
                },
                'additional': [
                    { 'ref': 'debug', 'aliases': ('-d', '--debug'), 'required': False, 'expect_content': False }
                ]
        },
        'fn': _find_content,
        'on_reject': _apply
    },
}

# BEGIN CLIENT EVENTS -----

@client.event
async def on_ready() -> None:
    await on_startup()

@client.event
async def on_message(message) -> None:
    # INSTANTIATE MESSAGE HANDLER
    handler = Message_Handler(message, MESSAGE_MAP, config())
    bound_fn = handler.generate_fn()
    await bound_fn() # Resolves with fn / rejects with on_reject

@client.event
async def on_guild_join(guild):
    await update_all_servers()

@client.event
async def on_error(event, *args, **kwargs):
    err = traceback.format_exc()
    channel = args[0].channel
    report_path = get_bug_report_path(channel.name)
    with open(report_path, 'w') as er:
        er.write(str(err))
    if config().is_debug:
        embeded = discord.Embed(title="Error Occured :(",
        url='https://github.com/nickheyer/DiscoFlix/issues/new',
        description='\nError occured. ' +
                    'Consider copy and pasting the below ' +
                    'log file into a bug report ' +
                    'using the below link.\n\nThank you!',
        color=0x966FD6)
        embeded.set_author(name=str(client.user),
        icon_url=client.user.display_avatar)
        embeded.add_field(name='Submit Bug Report:',
        value='https://github.com/nickheyer/DiscoFlix/issues/new',
        inline=False)
        embeded.add_field(name='Error Preview:',
        value=f'```{str(err)[:512]}...```',
        inline=False)
        await channel.send(embed=embeded)
        await channel.send(file=discord.File(report_path))

# START APP -----

if __name__ == "__main__":
    try:
        client.run(args.token)
    except:
        raise Exception('Bot unable to start. Is token valid?')
