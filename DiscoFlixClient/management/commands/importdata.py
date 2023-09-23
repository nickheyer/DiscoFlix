from django.core.management import BaseCommand
from django.core.management import call_command
from django.apps import apps
from django.core.serializers import base, python, deserialize
from django.db import migrations
import sys



def load_fixture(json_data):
    old_get_model = python._get_model

    def _get_model(model_identifier):
        try:
            return apps.get_model(model_identifier)
        except (LookupError, TypeError):
            raise base.DeserializationError("Invalid model identifier: '%s'" % model_identifier)

    python._get_model = _get_model

    try:
        for obj in deserialize('json', json_data):
            obj.save()
    finally:
        # Restore old _get_model() function
        python._get_model = old_get_model

class Command(BaseCommand):
    help = 'Load data from a JSON string'

    def handle(self, *args, **options):
      data = sys.stdin.read()
      load_fixture(data)