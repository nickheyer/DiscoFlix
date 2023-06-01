import os
import sys

# SYSPATH REQUIRES APPENDING AFTER LAUNCHING AS SUBPROC
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import socketio
import discord
from discord import app_commands
import traceback
import argparse

from lib.utils import get_bug_report_path
from bot.request_handler import RequestHandler
from bot.message_handler import Message_Handler, From_Interaction
from bot.config_manager import config
from bot.user_manager import (
    get_users_in_server,
    get_user_requests_last_24_hours,
    get_user,
)
from bot.ui_manager import ApproveNewUser, ListCommands

# SUBPROC CMD ARGS
parser = argparse.ArgumentParser()
parser.add_argument("--host", help="the websocket host", required=True)
parser.add_argument("--token", help="discord token", required=True)
args = parser.parse_args()

# DECLARING INTENTS (SEE README FOR CONTRIBUTORS)
intents = discord.Intents.all()
intents.members = True

# INSTANTIATING DISCORD CLIENT
client = discord.Client(intents=intents)
embeded = discord.Embed()

# INSTANTIATING DISCORD COMMAND TREE
tree = app_commands.CommandTree(client)

# SOCKETIO INSTANTIATION
SIO = socketio.AsyncClient()


# STARTUP FUNCTIONS -----
async def socket_start():
    await SIO.connect(f"http://{args.host}")


async def change_bot_presence(presence):
    await client.change_presence(
        activity=discord.Activity(
            type=discord.ActivityType.watching, name=f"& {presence.lower()}"
        )
    )
    await SIO.emit("change_client_status", {"status": presence, "bot_name": "discord"})


async def on_startup():
    await socket_start()
    stat = "listening"
    print(f"Bot is ready to party, logged in as {client.user}. Currently {stat}.")
    await change_bot_presence(stat.title())
    await update_all_servers()
    await SIO.emit(
        "bot_started", {"success": True, "status": stat, "bot_name": "discord"}
    )
    return

async def update_slash_commands():
    for cmd, val in MESSAGE_MAP.items():
        if not val.get('is_slash', True):
            continue
        command = app_commands.Command(
            name=str(cmd),
            description=val.get('description', ''),
            callback=stub_callback_with_arg if (
            'primary' in val.get('args', [])
            and val['args']['primary'].get('used', False)
            ) else stub_callback,
            guild_ids=None,
        )
        tree.add_command(command, override=True)
    await tree.sync(guild=None)

async def update_all_servers():
    servers = [
        {"server_name": str(guild), "server_id": guild.id} for guild in client.guilds
    ]
    await SIO.emit("all_servers_from_bot", {"servers": servers})


# SOCKET EVENTS -----
@SIO.on("get_unadded_users_from_bot")
async def get_all_users(data):
    unadded = list(
        {
            str(m)
            for g in client.guilds
            for m in g.members
            if not m.bot and str(m) not in data["users"]
        }
    )
    await SIO.emit("unadded_users_from_bot", {"unadded": unadded})


@SIO.on("get_servers_for_user")
async def get_user_info(data):
    # Not really being used till TODO (app.py) implemented
    servers = []
    for guild in client.guilds:
        for guild_member in guild.members:
            if not guild_member.bot and str(guild_member) == data["user"]:
                servers.append({"server_name": str(guild), "server_id": guild.id})
    await SIO.emit(
        "user_servers_from_bot",
        {"user_info": {"servers": servers, "username": data["user"]}},
    )


# HELPERS/UTILS ------
async def add_log(log_message):
    await SIO.emit("bot_add_log", {"log": log_message})


async def send_message(message_object, message_to_send, log=False):
    if log:
        await add_log(f"{client.user}: {message_to_send}")
    return await message_object.channel.send(message_to_send)


def get_user_from_username(username, message_object=None):
    if message_object:
        return message_object.guild.get_member_named(username)
    else:
        for guild in client.guilds:
            for guild_member in guild.members:
                if not guild_member.bot and str(guild_member) == username:
                    return guild_member
    return None


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


def generate_mention_users_with(message_object, permissions=[]):
    users = get_users_in_server_with(message_object, permissions)
    message_template = ""
    for user in users:
        message_template += f"{user.mention}\n"
    return message_template


async def add_user_from_message(message_object, admin=False, restrict_servers=True):
    user_dict = {
        "username": str(message_object.author),
        "is_server_restricted": restrict_servers,
        "is_admin": admin,
        "servers": [
            {
                "server_name": str(message_object.guild),
                "server_id": message_object.guild.id,
            }
        ],
    }
    await SIO.emit("add_edit_user", {"user_info": user_dict})


async def add_user_from_info(
    username, message_object, admin=False, restrict_servers=True
):
    user_dict = {
        "username": username,
        "is_server_restricted": restrict_servers,
        "is_admin": admin,
        "servers": [
            {
                "server_name": str(message_object.guild),
                "server_id": message_object.guild.id,
            }
        ],
    }
    await SIO.emit("add_edit_user", {"user_info": user_dict})


async def refresh_users():
    await SIO.emit("refresh_users", {})

async def stub_callback(interaction: discord.Interaction):
    pass

async def stub_callback_with_arg(interaction: discord.Interaction, input: str):
    pass

# MESSAGE FUNCTIONS ------
async def _test(m, options):
    await send_message(m, "Testing!")
    if options["debug"]:
        await send_message(m, f'```python\n{options["command"]}\n```')


async def _echo(m, options):
    await send_message(
        m,
        options["primary"],
    )
    if options["debug"]:
        await send_message(m, f'```python\n{options["command"]}\n```')


async def _err(m, options):
    await send_message(m, "Let's throw an error!")
    if options["specify"]:
        raise Exception(options["specify"])
    else:
        raise Exception("THIS IS AN INTENDED ERROR!")


async def _log(m, options):
    if options["message"]:
        await send_message(m, f"Log added!\n```\n{options['primary']}\n```")
    await add_log(options["primary"])


async def _apply(m, options):
    await change_bot_presence(f"Adding Users")
    admins = get_users_in_server_with(m, ["admin"])
    admin_mention = generate_mention_users_with(m, ["admin"])
    response_message = f"User requires registration before requests can be made.\nAdmin approval needed.\n{admin_mention}"
    view = ApproveNewUser(options, m, admins, response_message)
    timeout = await view.send_response()
    if not timeout:
        if view.result in ["DENIED", False, None]:
            return
        await add_user_from_message(m, view.result == "REGISTER_ADMIN")
        await add_log(f"Added User: {m.author} ({view.result})")
    else:
        print("Timed-Out")
    return


async def _find_content(m, options):
    if not get_user_requests_last_24_hours(str(m.author)):
        return
    await change_bot_presence(f"Downloading")
    handler = RequestHandler(options, m, add_log)
    if not await handler.validate_request():
        return False
    return await handler.process_request()


async def _help(m, options):
    commands = ListCommands(options, m, MESSAGE_MAP)
    embed = commands.generate_embed()
    await m.reply(embed=embed)
    return True


async def _add_user(m, options):
    users_to_add = []
    if len(m.mentions) == 0:
        existing = get_user(options["primary"])
        if options["delete"] and existing:
            users_to_add.append(existing.id)
        elif not existing:
            users_to_add.append(options["primary"])
    else:
        for user in m.mentions:
            existing = get_user(str(user))
            if options["delete"] and existing:
                users_to_add.append(existing.id)
            elif not existing:
                users_to_add.append(str(user))
    if options["admin"] and not options["user"].is_server_owner:
        final_color = discord.Color.brand_red()
        final_title = "Authorization Denied"
        description = "You do not have the permissions to perform this action!"
    elif not users_to_add:
        final_color = discord.Color.brand_red()
        final_title = "No Users To Add"
        description = "Note: Users cannot be added a second time!"
    elif options["delete"]:
        final_color = discord.Color.brand_green()
        final_title = "Authorization Granted"
        for u in users_to_add:
            await SIO.emit("delete_user", {"user_id": u})
        description = f"{m.author.mention} Deleted: {options['primary']}"
    else:
        final_color = discord.Color.brand_green()
        final_title = "Authorization Granted"
        for u in users_to_add:
            await add_user_from_info(u, m, options["admin"])
            await add_log(f"Added User: {u}")
        description = f"{m.author.mention} Added: {options['primary']}"
    embed = discord.Embed(title=final_title, color=final_color)
    embed.description = description
    await m.reply(embed=embed)

# MESSAGE MAP ------
MESSAGE_MAP = {
    "test": {
        "ref": "test",
        "permissions": ["user", "developer"],
        "slash_enabled": True,
        "aliases": ["test"],
        "requirements": [],
        "args": {
            "primary": {"required": False, "used": False},
            "additional": [
                {
                    "ref": "debug",
                    "aliases": ("-d", "--debug"),
                    "required": False,
                    "expect_content": False,
                },
            ],
        },
        "fn": _test,
        "description": "Confirm bot is on and listening",
    },
    "help": {
        "ref": "help",
        "permissions": [],
        "slash_enabled": True,
        "aliases": ["help"],
        "requirements": [],
        "args": {"primary": {"required": False, "used": False}, "additional": []},
        "fn": _help,
        "description": "Display all authorized commands.",
    },
    "echo": {
        "ref": "echo",
        "permissions": ["developer", "owner"],
        "slash_enabled": True,
        "aliases": ["echo"],
        "requirements": [],
        "args": {
            "primary": {"ref": "text to echo", "required": True, "used": True},
            "additional": [
                {
                    "ref": "debug",
                    "aliases": ("-d", "--debug"),
                    "required": False,
                    "expect_content": False,
                },
            ],
        },
        "fn": _echo,
        "description": "Confirm bot is handling input as intended.",
    },
    "error": {
        "ref": "error",
        "permissions": ["developer", "owner"],
        "slash_enabled": True,
        "aliases": ["error", "err", "raise"],
        "requirements": [],
        "args": {
            "primary": {"required": False, "used": False},
            "additional": [
                {
                    "ref": "specify",
                    "aliases": ("-s", "--specify"),
                    "required": False,
                    "expect_content": True,
                },
            ],
        },
        "fn": _err,
        "description": "Confirm bot is handling errors as intended",
    },
    "log": {
        "ref": "log",
        "permissions": ["developer", "owner"],
        "slash_enabled": True,
        "aliases": ["log", "add-log"],
        "requirements": [],
        "args": {
            "primary": {"ref": "text to log", "required": True, "used": True},
            "additional": [
                {
                    "ref": "message",
                    "aliases": ("-m", "--message"),
                    "required": False,
                    "expect_content": False,
                }
            ],
        },
        "fn": _log,
        "description": "Confirm bot is logging information to console as intended",
    },
    "movie": {
        "ref": "movie",
        "permissions": ["user", "developer"],
        "slash_enabled": True,
        "aliases": ["movie", "add-movie"],
        "requirements": ["is_radarr_enabled", "radarr_token", "radarr_url"],
        "args": {
            "primary": {"ref": "title", "required": True, "used": True},
            "additional": [],
        },
        "fn": _find_content,
        "on_reject": _apply,
        "description": "Request a movie",
    },
    "show": {
        "ref": "show",
        "permissions": ["user", "developer"],
        "slash_enabled": True,
        "aliases": ["show", "add-show", "tv-show", "add-tv-show", "tv", "tvshow"],
        "requirements": ["is_sonarr_enabled", "sonarr_token", "sonarr_url"],
        "args": {
            "primary": {"ref": "title", "required": True, "used": True},
            "additional": [],
        },
        "fn": _find_content,
        "on_reject": _apply,
        "description": "Request a tv-show",
    },
    "user": {
        "ref": "user",
        "permissions": ["admin", "owner"],
        "slash_enabled": True,
        "aliases": ["user", "add-user", "add", "delete-user", "delete"],
        "requirements": [],
        "args": {
            "primary": {"ref": "user", "required": True, "used": True},
            "additional": [
                {
                    "ref": "admin",
                    "aliases": ("-a", "--admin"),
                    "required": False,
                    "expect_content": False,
                },
                {
                    "ref": "delete",
                    "aliases": ("-d", "--delete"),
                    "required": False,
                    "expect_content": False,
                },
            ],
        },
        "fn": _add_user,
        "description": "Add/modify users",
    },
}

# BEGIN CLIENT EVENTS -----

@client.event
async def on_ready() -> None:
    await on_startup()
    await update_slash_commands()
    
@client.event
async def on_interaction(interaction) -> None:
    if interaction.type == discord.InteractionType.application_command:
        await interaction.response.send_message(content='*...*', silent=True, ephemeral=True, delete_after=0.5)
        converted = From_Interaction(interaction, config())
        await on_message(message=converted)
        

@client.event
async def on_message(message) -> None:
    # INSTANTIATE MESSAGE HANDLER
    handler = Message_Handler(message, MESSAGE_MAP, config())
    bound_fn = handler.generate_fn()
    await bound_fn()  # Resolves with fn / rejects with on_reject

@client.event
async def on_guild_join(guild):
    await update_all_servers()


@client.event
async def on_error(event, *args, **kwargs):
    err = traceback.format_exc()
    channel = args[0].channel
    report_path = get_bug_report_path(channel.name)
    with open(report_path, "w") as er:
        er.write(str(err))
    if config().is_debug:
        embeded = discord.Embed(
            title="Error Occured :(",
            url="https://github.com/nickheyer/DiscoFlix/issues/new",
            description="\nError occured. "
            + "Consider copy and pasting the below "
            + "log file into a bug report "
            + "using the below link.\n\nThank you!",
            color=0x966FD6,
        )
        embeded.set_author(name=str(client.user), icon_url=client.user.display_avatar)
        embeded.add_field(
            name="Submit Bug Report:",
            value="https://github.com/nickheyer/DiscoFlix/issues/new",
            inline=False,
        )
        embeded.add_field(
            name="Error Preview:", value=f"```{str(err)[:512]}...```", inline=False
        )
        await channel.send(embed=embeded)
        await channel.send(file=discord.File(report_path))


# START APP -----

if __name__ == "__main__":
    try:
        client.run(args.token)
    except:
        raise Exception("Bot unable to start. Is token valid?")
