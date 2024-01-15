from dotenv import load_dotenv
load_dotenv()

import os
import pytest_asyncio
import pytest
import discord.ext.test as dpytest
from DiscoFlixClient.models import Configuration, User
from channels.db import database_sync_to_async
from DiscoFlixBot.bot import DiscordBot
from django.core.management import call_command


@pytest.mark.django_db(transaction=True)
@database_sync_to_async
def mock_configuration():
    print('--- CREATING CONFIGURATION IN DB ----')
    config = Configuration.objects.first()
    if not config:
        config = Configuration.objects.create()
    config.media_server_name="DiscoFlix Test Server"
    config.discord_token = os.getenv('TEST_DISCORD_TOKEN')
    config.radarr_url = os.getenv('TEST_RADARR_URL')
    config.radarr_token = os.getenv('TEST_RADARR_TOKEN')
    config.sonarr_url = os.getenv('TEST_SONARR_URL')
    config.sonarr_token = os.getenv('TEST_SONARR_TOKEN')
    config.save
    return config

@pytest.mark.django_db(transaction=True)
@database_sync_to_async
def mock_users():
    print('--- CREATING USER(S) IN DB ----')
    User.objects.create(
        username='TESTADMIN#0001',
        password='Password1234!',
        is_admin=True,
        is_server_restricted=False,
        is_superuser=True,
        is_staff=True,
    )
    User.objects.create(
        username='TESTUSER#0002',
        password='Password1234!',
        is_admin=False,
        is_server_restricted=False,
        is_superuser=False,
        is_staff=False,
    )


@pytest_asyncio.fixture
@pytest.mark.django_db(transaction=True)
async def bot():
    call_command('initializedb')

    await mock_users()
    await mock_configuration()

    print('--- INSTANTIATING BOT ----')
    DF_BOT = DiscordBot()
    DF_CLIENT = DF_BOT.client
    await DF_CLIENT._async_setup_hook()
    dpytest.configure(DF_CLIENT)
    
    # USERS JOINS SERVER
    guild = DF_CLIENT.guilds[0]
    discord_users = [
        'TESTADMIN',
        'TESTUSER',
        'TESTNONUSER'
    ]
    for i, username in enumerate(discord_users):
        await dpytest.member_join(
            guild=guild,
            user=None,
            name=username,
            discrim=i+1
        )    
    yield DF_CLIENT
    await dpytest.empty_queue()


def pytest_sessionfinish(session, exitstatus):
    print("--- TESTING CONCLUDED ---\n\n", session, exitstatus)
    """ Code to execute after all tests. """
    
