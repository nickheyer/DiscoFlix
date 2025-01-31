from django.db import models
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.utils.timezone import now

import os

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

    is_login_required = models.BooleanField("Enable/Require User Login For WebUI", default=False)
    is_verbose_logging = models.BooleanField("Verbose Logging In Console", default=False)
    is_debug = models.BooleanField("Send Debug Message On Error", default=False)
    is_radarr_enabled = models.BooleanField("Enable Radarr Requests", default=True)
    is_sonarr_enabled = models.BooleanField("Enable Sonarr Requests", default=True)
    is_trailers_enabled = models.BooleanField("Enable YouTube Trailers", default=True)

    is_tagging_enabled = models.BooleanField("Enable Tagging Content", default=False)
    tag_label = models.CharField("Tag Label", max_length=16, null=True, default="DF")
    radarr_tag_id = models.IntegerField("Radarr Tag ID", null=True, default=0)
    sonarr_tag_id = models.IntegerField("Sonarr Tag ID", null=True, default=0)
    is_request_existing_enabled = models.BooleanField("Allow Searching Monitored Content", default=False)
    
    # AI SPECIFIC CONFIGS
    openai_token = models.CharField("OpenAI Token", max_length=255, null=True, default="")
    openai_model_name = models.CharField("OpenAI Model Name", max_length=255, null=True, default="gpt-3.5-turbo")
    is_openai_enabled = models.BooleanField("Enable OpenAI Chatbot", default=False)
    is_mention_enabled = models.BooleanField('Enable Talking to AI by Mentioning ("@bot") Your Bot User', default=False)
    

class State(models.Model):
    discord_state = models.BooleanField(default=False)
    app_state = models.BooleanField(default=True)
    current_activity = models.CharField(max_length=255, default="Offline")
    host_url = models.CharField(max_length=128, default='0.0.0.0:5454')


class ErrLog(models.Model):
    created = models.DateTimeField(auto_now_add=True)
    entry = models.CharField(max_length=2048, default="Error Occured")


class EventLog(models.Model):
    created = models.DateTimeField(auto_now_add=True)
    entry = models.CharField(max_length=2048, default="Event Occured")


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
    tvdb_id = models.CharField(max_length=255, null=True)
    imdb_id = models.CharField(max_length=255, null=True)
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


class UserManager(BaseUserManager):
    def create_user(self, username, password=None, **extra_fields):
        if not username:
            raise ValueError('The Username field is required')
        user = self.model(username=username, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

class User(AbstractBaseUser, PermissionsMixin):
    added = models.DateTimeField(default=now, editable=True, )
    is_admin = models.BooleanField(default=False)
    is_server_restricted = models.BooleanField(default=False)
    username = models.CharField(max_length=255, unique=True, null=False)
    discord_servers = models.ManyToManyField(DiscordServer, related_name="users", blank=True)
    requests = models.ManyToManyField(MediaRequest, related_name="users", blank=True)
    is_additional_settings = models.BooleanField(default=False)
    is_superuser = models.BooleanField(default=False)
    is_staff = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    session_timeout = models.IntegerField(default=60)
    max_check_time = models.IntegerField(default=600)
    max_results = models.IntegerField(default=0)
    max_seasons_for_non_admin = models.IntegerField(default=0)
    max_requests_in_day = models.IntegerField(default=0)
    is_request_existing_enabled = models.BooleanField(default=False)

    objects = UserManager()

    USERNAME_FIELD = 'username'
    REQUIRED_FIELDS = []

    def has_perm(self, perm, obj=None):
        """Does the user have a specific permission?"""
        return True

    def has_module_perms(self, app_label):
        """Does the user have permissions to view the app"""
        return True

    def __str__(self):
        return self.username


