from django.apps import AppConfig
from django.core.management import call_command

class DiscoFlixClientConfig(AppConfig):
    name = 'DiscoFlixClient'

    def ready(self):
        # call your management command here
        print('Initializing DB')
        call_command('initializedb')