from django.core.management.base import BaseCommand
from DiscoFlixClient.models import (
    Configuration,
    State
)

class Command(BaseCommand):
    help = 'Create a Default instances if they do not exist'

    def handle(self, *args, **kwargs):
        config, config_created = Configuration.objects.get_or_create()
        state, state_created = State.objects.get_or_create()
        self.stdout.write(self.style.SUCCESS('Successfully initialized DB'))
