import discord
import traceback
from io import StringIO

from DiscoFlixClient.utils import (
    get_config as config
)

from DiscoFlixBot.parser import (
    MessageHandler,
    FromInteraction
)

# DISCORD BOT EVENTS - LOADED ON INSTANTIATION BY BOT.PY


# WHEN BOT JOINS SERVER
async def on_guild_join(bot, guild):
    await bot.get_servers()
    await bot.send_log(f"{bot.client.user} JOINED {guild.name}")

# WHEN BOT SIGNS IN / STARTS UP
async def on_ready(bot):
    status = f"CONNECTED WITH {bot.client.user}"
    await bot.get_servers()
    await bot.send_log(status)
    await bot.change_presence("Waiting for input...")
    await bot.tree.sync(guild=None)
    await bot.emit(
        {"event": "bot_on_finished", "data": {"success": True, "bot_name": "discord"}}
    )

# WHEN BOT SEES A NEW MESSAGE IN CHAT
async def on_message(bot, message):
    if message.author == bot.client.user:
        return
    config_cls = await config()
    ctx = MessageHandler(bot, message, config_cls)
    fn = await ctx.get_fn()
    await fn()

# WHEN BOT GETS SLASH COMMAND
async def on_interaction(bot, interaction) -> None:
    if interaction.type != discord.InteractionType.application_command:
      return
    config_cls = await config()
    await interaction.response.send_message(content='*...*', silent=True, ephemeral=True, delete_after=0.5)
    message = FromInteraction(interaction, config_cls)
    ctx = MessageHandler(bot, message, config_cls)
    fn = await ctx.get_fn()
    await fn()

# WHEN BOT ENCOUNTERS ERROR
async def on_error(bot, *args):
    err = traceback.format_exc()
    channel = args[0].channel
    report_content = StringIO(str(err))
    config_cls = await config()
    if config_cls.is_debug:
        embeded = discord.Embed(
            title="Error Occured :(",
            url="https://github.com/nickheyer/DiscoFlix/issues/new",
            description="\nError occured. "
            + "Consider copy and pasting the below "
            + "log file into a bug report "
            + "using the below link.\n\nThank you!",
            color=0x966FD6,
        )
        embeded.set_author(name=str(bot.client.user), icon_url=bot.client.user.display_avatar)
        embeded.add_field(
            name="Submit Bug Report:",
            value="https://github.com/nickheyer/DiscoFlix/issues/new",
            inline=False,
        )
        embeded.add_field(
            name="Error Preview:", value=f"```{str(err)[:512]}...```", inline=False
        )
        await channel.send(embed=embeded)
        report_content.seek(0) # Reset the file pointer to the beginning of the file
        await channel.send(file=discord.File(report_content, filename="error_log.txt"))