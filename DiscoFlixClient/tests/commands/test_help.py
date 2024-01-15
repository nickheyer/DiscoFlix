import pytest
import discord.ext.test as dpytest
import logging
from DiscoFlixClient.tests.common import common

LOGGER = logging.getLogger(__name__)

# TEST COMMAND
TEST_PREFIX = '!df'
TEST_COMMAND = 'help'
TEST_MESSAGE = f'{TEST_PREFIX} {TEST_COMMAND}'

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_help_admin(bot):
    # GET DISCORD USER
    TEST_ADMIN = common.get_user_by_name('TESTADMIN')

    # USER ISSUES COMMAND
    await dpytest.message(content=TEST_MESSAGE, member=TEST_ADMIN)
    await dpytest.run_all_events()

    # BOT RESPONDS WITH MESSAGE / EMBED
    sent_emb = dpytest.get_embed(peek=True)

    # EVALUATE GENERATED MESSAGE / EMBED
    assert sent_emb.title == 'Help'
    assert sent_emb.description == 'List of available commands:'
    
    embed_fields = sent_emb.fields
    available_commands = sorted([field.name.split(' ')[0] for field in embed_fields])
    expected_commands = sorted([
        'add-user',
        'error',
        'delete-user',
        'log',
        'test',
        'show',
        'movie',
        'add-admin',
        'help'
    ])

    assert available_commands == expected_commands

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_help_user(bot):
    # GET DISCORD USER
    TEST_USER = common.get_user_by_name('TESTUSER')

    # USER ISSUES COMMAND
    await dpytest.message(content=TEST_MESSAGE, member=TEST_USER)
    await dpytest.run_all_events()

    # BOT RESPONDS WITH MESSAGE / EMBED
    sent_emb = dpytest.get_embed(peek=True)

    # EVALUATE GENERATED MESSAGE / EMBED
    assert sent_emb.title == 'Help'
    assert sent_emb.description == 'List of available commands:'
    
    embed_fields = sent_emb.fields
    available_commands = sorted([field.name.split(' ')[0] for field in embed_fields])
    expected_commands = sorted([
        'help',
        'show',
        'movie'
    ])

    assert available_commands == expected_commands

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_help_nonuser(bot):
    # GET DISCORD USER
    TEST_NONUSER = common.get_user_by_name('TESTNONUSER')

    # USER ISSUES COMMAND
    await dpytest.message(content=TEST_MESSAGE, member=TEST_NONUSER)
    await dpytest.run_all_events()

    # BOT RESPONDS WITH MESSAGE / EMBED
    sent_emb = dpytest.get_embed(peek=True)

    # EVALUATE GENERATED MESSAGE / EMBED
    assert sent_emb.title == 'Help'
    assert sent_emb.description == 'List of available commands:'
    
    embed_fields = sent_emb.fields
    available_commands = sorted([field.name.split(' ')[0] for field in embed_fields])
    expected_commands = sorted([
        'help'
    ])

    assert available_commands == expected_commands

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_help_admin_with_debug(bot):
    # SET DEBUG TO TRUE IN CONFIG
    await common.edit_configuration(is_debug=True)

    # GET DISCORD USER
    TEST_ADMIN = common.get_user_by_name('TESTADMIN')

    # USER ISSUES COMMAND
    await dpytest.message(content=TEST_MESSAGE, member=TEST_ADMIN)
    await dpytest.run_all_events()

    # BOT RESPONDS WITH MESSAGE / EMBED
    sent_emb = dpytest.get_embed(peek=True)

    # EVALUATE GENERATED MESSAGE / EMBED
    assert sent_emb.title == 'Help'
    assert sent_emb.description == 'List of available commands:'
    
    embed_fields = sent_emb.fields
    debug_field = embed_fields.pop()
    assert debug_field.name == 'User Debug Information'

    [d_user, d_roles, d_commands] = debug_field.value.splitlines()
    assert d_user == 'Username: `TESTADMIN#0001`'
    assert all(exp in d_roles for exp in ['unrestricted', 'user', 'owner', 'admin'])
    assert d_commands == 'Commands Registered: `11`'
    
    available_commands = sorted([field.name.split(' ')[0] for field in embed_fields])
    expected_commands = sorted([
        'add-user',
        'echo',
        'reject',
        'error',
        'delete-user',
        'log',
        'test',
        'show',
        'movie',
        'add-admin',
        'help'
    ])

    assert available_commands == expected_commands

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_help_user_with_debug(bot):
    # SET DEBUG TO TRUE IN CONFIG
    await common.edit_configuration(is_debug=True)

    # GET DISCORD USER
    TEST_USER = common.get_user_by_name('TESTUSER')

    # USER ISSUES COMMAND
    await dpytest.message(content=TEST_MESSAGE, member=TEST_USER)
    await dpytest.run_all_events()

    # BOT RESPONDS WITH MESSAGE / EMBED
    sent_emb = dpytest.get_embed(peek=True)

    # EVALUATE GENERATED MESSAGE / EMBED
    assert sent_emb.title == 'Help'
    assert sent_emb.description == 'List of available commands:'
    
    embed_fields = sent_emb.fields
    debug_field = embed_fields.pop()
    assert debug_field.name == 'User Debug Information'

    [d_user, d_roles, d_commands] = debug_field.value.splitlines()
    assert d_user == 'Username: `TESTUSER#0002`'
    assert all(exp in d_roles for exp in ['unrestricted', 'user'])
    assert d_commands == 'Commands Registered: `11`'
    
    available_commands = sorted([field.name.split(' ')[0] for field in embed_fields])
    expected_commands = sorted([
        'add-user',
        'echo',
        'reject',
        'error',
        'delete-user',
        'log',
        'test',
        'show',
        'movie',
        'add-admin',
        'help'
    ])

    assert available_commands == expected_commands

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_help_nonuser_with_debug(bot):
    # SET DEBUG TO TRUE IN CONFIG
    await common.edit_configuration(is_debug=True)

    # GET DISCORD USER
    TEST_NONUSER = common.get_user_by_name('TESTNONUSER')

    # USER ISSUES COMMAND
    await dpytest.message(content=TEST_MESSAGE, member=TEST_NONUSER)
    await dpytest.run_all_events()

    # BOT RESPONDS WITH MESSAGE / EMBED
    sent_emb = dpytest.get_embed(peek=True)

    # EVALUATE GENERATED MESSAGE / EMBED
    assert sent_emb.title == 'Help'
    assert sent_emb.description == 'List of available commands:'
    
    embed_fields = sent_emb.fields
    debug_field = embed_fields.pop()
    assert debug_field.name == 'User Debug Information'

    [d_user, d_roles, d_commands] = debug_field.value.splitlines()
    assert d_user == 'Username: `TESTNONUSER#0003`'
    assert all(exp in d_roles for exp in ['unregistered'])
    assert d_commands == 'Commands Registered: `11`'
    
    available_commands = sorted([field.name.split(' ')[0] for field in embed_fields])
    expected_commands = sorted([
        'add-user',
        'echo',
        'reject',
        'error',
        'delete-user',
        'log',
        'test',
        'show',
        'movie',
        'add-admin',
        'help'
    ])

    assert available_commands == expected_commands
    