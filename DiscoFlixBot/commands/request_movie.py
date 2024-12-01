from DiscoFlixBot.base_command import Command
from DiscoFlixBot.managers.request_manager import RequestHandler
from DiscoFlixBot.lib.utils.utils import handle_unregistered

class RequestMovieCommand(Command):


    def __init__(self) -> None:
        super().__init__()
        self.name = "movie"
        self.aliases = ['movie', 'film']
        self.permissions = ["user", "owner", "admin", "developer"]
        self.description = "Request a movie"
        self.conditions = ["is_radarr_enabled", "radarr_token", "radarr_url"]
        self.requires_input = True

    async def execute(self, message, ctx):
        handler = RequestHandler(ctx)
        if not await handler.validate_request():
            return False
        return await handler.process_request()

    async def reject(self, message, ctx):
        reason = getattr(ctx, 'rejection', 'Status 500 (Server Error)')
        await ctx.bot.send_log(f'REJECTED REQUEST: {reason}')
        if reason == 'Failed to validate user request based on current permissions or state.':
            await ctx.bot.change_presence("Adding Users...")
            await handle_unregistered(message, ctx)
