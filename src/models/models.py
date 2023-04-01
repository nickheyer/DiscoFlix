from peewee import *
from playhouse.sqlite_ext import SqliteDatabase
# http://docs.peewee-orm.com/en/latest/peewee/

import datetime
from pathlib import Path

from lib.utils import (
    get_db_file
)

DB_FILE = get_db_file()

db = SqliteDatabase(DB_FILE)

class BaseModel(Model):
    class Meta:
        database = db

class Configuration(BaseModel):
    media_server_name = CharField(default='The Server', verbose_name='Media Server Name')
    prefix_keyword = CharField(default='!df', verbose_name='Chat-Prefix For Requests')
    discord_token = CharField(default='', verbose_name='Discord Token')
    telegram_token = CharField(default='', verbose_name='Telegram Token')
    radarr_url = CharField(default='', verbose_name='Radarr Host-Url')
    radarr_token = CharField(default='', verbose_name='Radarr Token')
    sonarr_url = CharField(default='', verbose_name='Sonarr Host-Url')
    sonarr_token = CharField(default='', verbose_name='Sonarr Token')

    delay = IntegerField(default=1, verbose_name='Message Delay')
    session_timeout = IntegerField(default=60, verbose_name='Session Timeout')
    max_check_time = IntegerField(default=600, verbose_name='Time To Monitor Request-Fulfillment')
    max_results = IntegerField(default=-1, verbose_name='Max Results Provided To A Request (-1 Is All)')
    max_seasons_for_non_admin = IntegerField(default=-1, verbose_name='Max Number Seasons Non-Admin Can Request (-1 Is Any)')

    is_debug = BooleanField(default=False, verbose_name='Send Debug Message On Error')
    is_radarr_enabled = BooleanField(default=True, verbose_name='Enable Radarr Requests')
    is_sonarr_enabled = BooleanField(default=True, verbose_name='Enable Sonarr Requests')

class State(BaseModel):
    discord_state = BooleanField(default=False)
    telegram_state = BooleanField(default=False)
    app_state = BooleanField(default=True)
    current_activity = CharField(default='Offline')

class ErrLog(BaseModel):
    id = AutoField()
    created = DateTimeField(default=datetime.datetime.now)
    entry = CharField(default="Error Occured")

class EventLog(BaseModel):
    id = AutoField()
    created = DateTimeField(default=datetime.datetime.now)
    entry = CharField(default="Event Occured")

class DiscordServer(BaseModel):
    id = AutoField()
    server_name = CharField(null=True)
    server_id = CharField(null=True)

class Media(BaseModel):
    id = AutoField()
    title = CharField(null=True)
    overview = TextField(null=True)
    poster_url = CharField(null=True)
    year = IntegerField(null=True)
    path = CharField(null=True)
    monitored = BooleanField(null=True)
    runtime = IntegerField(null=True)
    added = CharField(null=True)
    season_count = IntegerField(null=True)
    network = CharField(null=True)
    air_time = CharField(null=True)
    tvdb_id = IntegerField(null=True)
    first_aired = CharField(null=True)
    series_type = CharField(null=True)
    in_theaters = CharField(null=True)
    poster_url = CharField(null=True)
    website_url = CharField(null=True)
    trailer_url = CharField(null=True)

class MediaRequest(BaseModel):
    id = AutoField()
    created = CharField(default=datetime.datetime.now)
    made_in = ForeignKeyField(DiscordServer, backref='requests')
    media = ForeignKeyField(Media, backref='requests')
    orig_message = CharField(default='', null=True)
    orig_parsed_title = CharField(default='', null=True)
    orig_parsed_type = CharField(default='', null=True)

class User(BaseModel):
    id = AutoField()
    added = DateTimeField(default=datetime.datetime.now)
    is_admin = BooleanField(default=False)
    is_server_restricted = BooleanField(default=False)
    username = TextField(default=None, null=True)
    discord_servers = ManyToManyField(DiscordServer, backref='users', on_delete='CASCADE')
    requests = ManyToManyField(MediaRequest, backref='users')
 
DiscordServerUsers = User.discord_servers.get_through_model()
UserRequests = User.requests.get_through_model()


def initialize_db():
    db.connect()
    db.create_tables([
        Configuration,
        State,
        ErrLog,
        EventLog,
        User,
        DiscordServer,
        DiscordServerUsers,
        UserRequests,
        MediaRequest,
        Media
    ],
    safe=True)
    if not Configuration.select().exists():
        Configuration.create()
    if not State.select().exists():
        State.create()
            
if __name__ == '__main__':
    initialize_db()