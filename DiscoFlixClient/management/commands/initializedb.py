from django.core.management.base import BaseCommand
from django.db.utils import OperationalError
from DiscoFlixClient.models import (
    Configuration,
    State
)

class Command(BaseCommand):
    help = 'Create a Default instances if they do not exist'

    def handle(self, *args, **kwargs):
        try:
            _config, _config_created = Configuration.objects.get_or_create()
            _state, _state_created = State.objects.get_or_create()
            self.stdout.write(self.style.SUCCESS('Successfully initialized DB'))
        except OperationalError as e:
            self.stderr.write(self.style.ERROR(f'Database Operational Error: {e}'))
        except Exception as e:
            self.stderr.write(self.style.ERROR(f'Unexpected Error: {e}'))