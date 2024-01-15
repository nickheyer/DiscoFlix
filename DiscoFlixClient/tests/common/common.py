import discord.ext.test.runner as runner
import pytest_asyncio
import pytest
import discord.ext.test as dpytest
from DiscoFlixClient import utils
from channels.db import database_sync_to_async
import logging

LOGGER = logging.getLogger(__name__)

def get_user_by_name(name):
    test_config = runner.get_config()
    users = test_config.guilds[0].channels[0].members
    test_user = next((u for u in users if u.name == name))
    return test_user

@pytest.mark.django_db(transaction=True)
@database_sync_to_async
def edit_configuration(**kwargs):
    config = utils.get_config_sync()
    if not config:
        LOGGER.error('CONFIGURATION DOESNT EXIST IN DATABASE, CHECK FIXTURES')
        return
    changed = []
    for k, v in kwargs.items():
        if hasattr(config, k):
            attribute = getattr(config, k)
            if str(attribute) != str(v) and (attribute or v):
                changed.append(k)
            setattr(config, k, v)
    config.save()
    return config