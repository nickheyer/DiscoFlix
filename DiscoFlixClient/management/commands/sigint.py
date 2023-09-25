from django.core.management.base import BaseCommand
from DiscoFlixClient.utils import (
    update_state_sync,
    add_log_sync,
    get_state_sync
    
)

class Command(BaseCommand):
    help = 'To run when application is sent a signal interrupt'

    def handle(self, *args, **kwargs):
        state = get_state_sync()
        if state.discord_state:
            add_log_sync('[BOT] SIGINT: BOT SHUTTING DOWN')
        add_log_sync('[CLIENT] SIGINT: SERVER SHUTTING DOWN')
        status = {"current_activity": 'Offline'}
        update_state_sync(status)
        
        self.stdout.write(self.style.SUCCESS('SUCCESFUL SIGINT SHUTDOWN'))
