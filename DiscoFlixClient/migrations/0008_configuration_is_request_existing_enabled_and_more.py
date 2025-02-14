# Generated by Django 5.1.2 on 2025-01-14 05:00

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('DiscoFlixClient', '0007_configuration_is_login_required_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='configuration',
            name='is_request_existing_enabled',
            field=models.BooleanField(default=False, verbose_name='Allow Searching Monitored Content'),
        ),
        migrations.AddField(
            model_name='user',
            name='can_request_existing',
            field=models.BooleanField(default=False),
        ),
    ]
