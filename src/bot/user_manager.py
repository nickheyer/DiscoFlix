from models.models import (
    User,
    DiscordServerUsers,
    DiscordServer
)

DEVELOPER_USER_ACCOUNTS = [
    'NicholasHeyer#4212',
    'NicholasHeyer'
]

def eval_user_roles(user):
    roles = []
    if type(user) == str:
        user = User.get_or_none(username=user)
        if not user:
            return roles
    if user.is_admin:
        roles.extend(['user', 'admin'])
    else:
        roles.append('user')
    if user.is_server_restricted:
        roles.append('restricted')
    else:
        roles.append('unrestricted')
    if user.username in DEVELOPER_USER_ACCOUNTS:
        roles.append('developer')
    return roles

def get_users_for_auth(server_id, permissions):
    # Query for users in the given DiscordServer
    server = DiscordServer.get(server_id = server_id)
    users_in_server = (User
                    .select()
                    .join(DiscordServerUsers)
                    .where(DiscordServerUsers.discordserver == server.id))

    # Query for admin users who are not server restricted
    unrestricted_users = (User
                .select()
                .where(User.is_server_restricted == False))

    # Combine the two queries with an OR statement
    result = User.select().where((User.id << users_in_server) | (User.id << unrestricted_users))
    approved_users = []
    for user in result:
        user_roles = eval_user_roles(user)
        is_approved = True
        for perm in permissions:
            if perm not in user_roles:
                is_approved = False
                break
        if is_approved:
            approved_users.append(user.username)
    return approved_users
