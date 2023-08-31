from django.db import models
from django.utils.timezone import now

class Configuration(models.Model):
    media_server_name = models.CharField("Media Server Name", max_length=255, null=True, default="The Server")
    prefix_keyword = models.CharField("Chat-Prefix For Requests", max_length=255, null=True, default="!df")
    discord_token = models.CharField("Discord Token", max_length=255, null=True, default="")
    radarr_url = models.CharField("Radarr Host-Url", max_length=255, null=True, default="")
    radarr_token = models.CharField("Radarr Token", max_length=255, null=True, default="")
    sonarr_url = models.CharField("Sonarr Host-Url", max_length=255, null=True, default="")
    sonarr_token = models.CharField("Sonarr Token", max_length=255, null=True, default="")

    session_timeout = models.IntegerField("Session Timeout", null=True, default=60)
    max_check_time = models.IntegerField("Monitoring Timeout (Seconds)", null=True, default=600)
    max_results = models.IntegerField("Max Search Results", null=True, default=0)
    max_seasons_for_non_admin = models.IntegerField("Max Seasons For Non-Admin", null=True, default=0)

    is_verbose_logging = models.BooleanField("Verbose logging in console", default=False)
    is_debug = models.BooleanField("Send Debug Message On Error", default=False)
    is_radarr_enabled = models.BooleanField("Enable Radarr Requests", default=True)
    is_sonarr_enabled = models.BooleanField("Enable Sonarr Requests", default=True)
    is_trailers_enabled = models.BooleanField("Enable YouTube Trailers", default=True)


class State(models.Model):
    discord_state = models.BooleanField(default=False)
    app_state = models.BooleanField(default=True)
    current_activity = models.CharField(max_length=255, default="Offline")


class ErrLog(models.Model):
    created = models.DateTimeField(auto_now_add=True)
    entry = models.CharField(max_length=255, default="Error Occured")


class EventLog(models.Model):
    created = models.DateTimeField(auto_now_add=True)
    entry = models.CharField(max_length=255, default="Event Occured")


class DiscordServer(models.Model):
    server_name = models.CharField(max_length=255, null=True)
    server_id = models.CharField(max_length=255, null=True)


class Media(models.Model):
    title = models.CharField(max_length=255, null=True)
    overview = models.TextField(null=True)
    poster_url = models.CharField(max_length=255, null=True)
    year = models.IntegerField(null=True)
    path = models.CharField(max_length=255, null=True)
    monitored = models.BooleanField(null=True)
    runtime = models.IntegerField(null=True)
    added = models.CharField(max_length=255, null=True)
    season_count = models.IntegerField(null=True)
    network = models.CharField(max_length=255, null=True)
    air_time = models.CharField(max_length=255, null=True)
    tvdb_id = models.IntegerField(null=True)
    imdb_id = models.IntegerField(null=True)
    first_aired = models.CharField(max_length=255, null=True)
    series_type = models.CharField(max_length=255, null=True)
    in_theaters = models.CharField(max_length=255, null=True)
    website_url = models.CharField(max_length=255, null=True)
    trailer_url = models.CharField(max_length=255, null=True)


class MediaRequest(models.Model):
    created = models.DateTimeField(auto_now_add=True)
    made_in = models.ForeignKey(DiscordServer, related_name="requests", on_delete=models.CASCADE, null=True)
    media = models.ForeignKey(Media, related_name="requests", on_delete=models.CASCADE, null=True)
    orig_message = models.CharField(max_length=255, default="", null=True)
    orig_parsed_title = models.CharField(max_length=255, default="", null=True)
    orig_parsed_type = models.CharField(max_length=255, default="", null=True)
    status = models.BooleanField(default=False, null=True)


class User(models.Model):
    added = models.DateTimeField(default=now, editable=True, )
    is_admin = models.BooleanField(default=False)
    is_server_restricted = models.BooleanField(default=False)
    username = models.TextField(null=True)
    discord_servers = models.ManyToManyField(DiscordServer, related_name="users")
    requests = models.ManyToManyField(MediaRequest, related_name="users")
    is_additional_settings = models.BooleanField(default=False)
    is_server_owner = models.BooleanField(default=False)
    session_timeout = models.IntegerField(default=60)
    max_check_time = models.IntegerField(default=600)
    max_results = models.IntegerField(default=0)
    max_seasons_for_non_admin = models.IntegerField(default=0)
    max_requests_in_day = models.IntegerField(default=0)