# Generated by Django 5.1.2 on 2024-12-01 01:15

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('DiscoFlixClient', '0004_configuration_is_openai_enabled'),
    ]

    operations = [
        migrations.AddField(
            model_name='configuration',
            name='is_mention_enabled',
            field=models.BooleanField(default=False, verbose_name='Enable Talking to AI by Mentioning ("@bot") Your Bot User'),
        ),
    ]