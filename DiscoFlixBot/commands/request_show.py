from DiscoFlixBot.base_command import Command
from DiscoFlixBot.managers.request_manager import RequestHandler

class RequestShowCommand(Command):
    name = "show"
    permissions = ["user", "owner", "admin", "developer"]
    description = "Request a show"
    conditions = ["is_sonarr_enabled", "sonarr_token", "sonarr_url"]
    requires_input = True

    async def execute(self, message, ctx):
        handler = RequestHandler(ctx)
        if not await handler.validate_request():
            return False
        return await handler.process_request()