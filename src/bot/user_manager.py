from models.models import (
    User,
    DiscordServerUsers,
    DiscordServer,
    UserRequests,
    MediaRequest,
)

from playhouse.shortcuts import model_to_dict

DEVELOPER_USER_ACCOUNTS = ["NicholasHeyer#4211"]


def get_user(username):
    user = User.get_or_none(username=username)
    return user


def eval_user_roles(user):
    roles = []
    if type(user) == str:
        user, username = User.get_or_none(username=user), user
        if not user:
            return (
                ["developer", "unregistered"]
                if username in DEVELOPER_USER_ACCOUNTS
                else ["unregistered"]
            )
    if user.is_admin:
        roles.extend(["user", "admin"])
    else:
        roles.append("user")
    if user.is_server_restricted:
        roles.append("restricted")
    else:
        roles.append("unrestricted")
    if user.username in DEVELOPER_USER_ACCOUNTS:
        roles.append("developer")
    return roles


def get_users_for_auth(server_id, permissions, username):
    # unregistered users are ones not in the DB at all
    if "unregistered" in permissions and not User.get_or_none(username=username):
        return True

    # Query for users in the given DiscordServer
    server = DiscordServer.get(server_id=server_id)
    users_in_server = (
        User.select()
        .join(DiscordServerUsers)
        .where(DiscordServerUsers.discordserver == server.id)
    )

    # Query for admin users who are not server restricted
    unrestricted_users = User.select().where(User.is_server_restricted == False)

    # Combine the two queries with an OR statement
    result = User.select().where(
        (User.id << users_in_server) | (User.id << unrestricted_users)
    )

    approved_users = []
    for user in result:
        user_roles = eval_user_roles(user)
        is_approved = False
        for perm in permissions:
            if perm in user_roles:
                is_approved = True
                break
        if is_approved or not permissions:
            approved_users.append(user.username)
    return username in approved_users


def get_user_settings(username):
    user = User.get_or_none(username=username, is_additional_settings=True)
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


def get_users_in_server(server_id, permissions=[]):
    server = DiscordServer.get(server_id=server_id)
    users_in_server = (
        User.select()
        .join(DiscordServerUsers)
        .where(DiscordServerUsers.discordserver == server.id)
    )
    unrestricted_users = User.select().where(User.is_server_restricted == False)

    relev_users = User.select().where(
        (User.id << users_in_server) | (User.id << unrestricted_users)
    )

    if not permissions:
        return relev_users
    approved_users = []
    for user in relev_users:
        user_roles = eval_user_roles(user)
        is_approved = True
        for perm in permissions:
            if perm not in user_roles:
                is_approved = False
                break
        if is_approved:
            approved_users.append(user.username)
    return approved_users


import datetime
from peewee import fn


def get_user_requests_last_24_hours(username):
    user = User.get_or_none(User.username == username)

    if not user:
        return False

    now = datetime.datetime.now()
    one_day_ago = now - datetime.timedelta(days=1)

    # Filter MediaRequest instances created within the last 24 hours and requested by the given user
    recent_requests = (
        MediaRequest.select()
        .join(UserRequests)
        .join(User)
        .where((MediaRequest.created >= one_day_ago) & (User.id == user.id))
    )

    # Count the number of recent_requests
    request_count = recent_requests.count()

    request_limit = getattr(user, "max_requests_in_day", None)
    if request_limit and request_limit > 0 and request_count >= request_limit:
        return False
    return True
