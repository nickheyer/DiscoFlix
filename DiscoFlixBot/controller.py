from DiscoFlixClient.utils import get_config, get_config_sync, get_state_sync
from DiscoFlixBot.bot import DiscordBot
import asyncio


async def main():
    print("[CONTROLLER] BOT STARTING")

    config = await get_config()
    token = (
        config.discord_token
    )
    # 'OTQ2MjAxMzU5NDA4MDU0Mjcy.GEIE6I.q3hhs9wFoIrhhbbVkfKoGoDhIHbDjosCmy_38A'
    print(f'[CONTROLLER] BOT USING TOKEN: "{token}"')

    bot_instance = DiscordBot()
    await bot_instance.start(token)


async def kill():
    bot_instance = DiscordBot()
    await bot_instance.close()

    print("[CONTROLLER] BOT KILLED")
