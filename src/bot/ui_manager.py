import discord

from bot.user_manager import eval_user_roles, get_users_in_server, get_user
from lib.utils import generate_debug_file


class ContentSelectionView(discord.ui.View):
    def __init__(self, context, content_list, author, response_object):
        self.context = context
        self.config = context.get("config", {})
        super().__init__(timeout=self.config.session_timeout)
        self.timed_out = False
        self.author = author
        self.user_roles = eval_user_roles(str(author))
        self.user_config = get_user(str(author))
        self.content_list = content_list
        self.response_object = response_object
        self.current_index = 0
        self.result = None
        self.embed = None
        self.approval_required = False
        self.trailer_button = None
        self.trailer_message = None
        if "developer" in self.user_roles and self.config.is_debug:
            self._dev_debug_helpers()

    async def on_timeout(self) -> None:
        self.result = None
        await self.update_embed(timed_out=True)
        await self.response_object.edit(embed=self.embed, view=None)
        return await super().on_timeout()

    def _dev_debug_helpers(self):
        details = discord.ui.Button(
            label="Details",
            style=discord.ButtonStyle.secondary,
            custom_id="details",
            row=1,
        )
        details.callback = self.debug_details_button_callback
        self.add_item(details)

    async def debug_details_button_callback(self, interaction):
        if interaction.user.id != self.author.id:
            return
        file_path = generate_debug_file(self.content_list[self.current_index])
        file = discord.File(file_path, filename="debug.json")
        await interaction.response.send_message(content="_DEBUG_:", file=file)

    @discord.ui.button(
        label="<< Previous",
        style=discord.ButtonStyle.blurple,
        custom_id="prev",
        disabled=True,
        row=0,
    )
    async def previous_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user.id != self.author.id:
            return
        if self.current_index > 0:
            self.current_index -= 1
            await self.update_embed(interaction)

    @discord.ui.button(
        label="Select", style=discord.ButtonStyle.green, custom_id="select", row=0
    )
    async def select_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user.id != self.author.id:
            return
        await interaction.response.defer()
        if button.label == "Ask Admin":
            self.approval_required = True
        self.result = self.content_list[self.current_index]
        self.stop()

    @discord.ui.button(
        label="Cancel", style=discord.ButtonStyle.red, custom_id="cancel", row=0
    )
    async def cancel_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user.id != self.author.id:
            return
        await interaction.response.defer()
        self.stop()

    @discord.ui.button(
        label="Next >>", style=discord.ButtonStyle.blurple, custom_id="next", row=0
    )
    async def next_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user.id != self.author.id:
            return
        if self.current_index < len(self.content_list) - 1:
            self.current_index += 1
            await self.update_embed(interaction)

    async def change_button(self, button_id, disable_or_enable):
        for item in self.children:
            if item.custom_id == button_id:
                item.disabled = disable_or_enable
                break

    async def change_button_text(self, button_id, text):
        for item in self.children:
            if item.custom_id == button_id:
                item.label = text
                break

    async def update_requestor(self):
        self.embed.set_author(name=self.author, icon_url=self.author.display_avatar.url)
        self.embed.color = self.author.colour

    async def update_status(self, request_status, icon_url, update_embed=True):
        self.embed.set_footer(icon_url=icon_url, text=request_status)
        if update_embed:
            await self.response_object.edit(content=None, embed=self.embed, view=None)

    async def generate_trailer_message(self, interaction):
        if interaction.user.id != self.author.id:
            return
        self.remove_item(self.trailer_button)
        self.trailer_button = None
        if self.trailer_message:
            self.trailer_message = await self.trailer_message.edit(
                content=f'https://www.youtube.com/watch?v={self.content_list[self.current_index]["youTubeTrailerId"]}'
            )
        else:
            self.trailer_message = await self.response_object.reply(
                content=f'https://www.youtube.com/watch?v={self.content_list[self.current_index]["youTubeTrailerId"]}'
            )
        await interaction.response.edit_message(embed=self.embed, view=self)

    async def manage_trailer_button(self, is_created):
        if is_created and not self.trailer_button:
            self.trailer_button = discord.ui.Button(
                label="Trailer",
                style=discord.ButtonStyle.secondary,
                custom_id="trailer",
                row=1,
            )
            self.trailer_button.callback = self.generate_trailer_message
            self.add_item(self.trailer_button)
        elif not is_created and self.trailer_button:
            self.remove_item(self.trailer_button)
            self.trailer_button = None

    async def content_selected(self):
        await self.update_requestor()
        await self.update_status(
            request_status=f"Requested from server",
            icon_url="https://img.icons8.com/dotty/80/null/submit-progress.png",
            update_embed=False,
        )
        await self.response_object.edit(content=None, embed=self.embed, view=None)

    async def update_embed(self, interaction=False, timed_out=False):
        if timed_out:
            embed = discord.Embed(
                title="Request Timed-Out", color=discord.Color.brand_red()
            )
            embed.description = "No responses provided, moving on."
            self.embed = embed
            return embed
        content = self.content_list[self.current_index]
        embed = discord.Embed(
            title=f"{content.get('title', 'Unitled')}",
            color=0x966FD6,
            url=content.get("website", None),
        )
        embed.title += (
            f' ({content["year"]})'
            if "year" in content
            and str(content["year"]) not in content.get("title", "")
            else ""
        )
        embed.set_image(
            url=content.get("remotePoster", "https://i.imgur.com/1glpRCZ.png?1")
        )
        seasons = content.get("seasonCount", None)
        if seasons:
            embed.insert_field_at(index=0, name="Seasons", value=seasons, inline=True)
            if not self.user_config.is_admin and (
                self.config.max_seasons_for_non_admin != 0
                and seasons > self.config.max_seasons_for_non_admin
            ):
                await self.change_button_text("select", "Ask Admin")
            else:
                await self.change_button_text("select", "Select")
        else:
            await self.change_button_text("select", "Select")
        relevant_fields = {"runtime": " Minutes", "status": "", "episodeCount": ""}
        for key, value in content.items():
            if key in relevant_fields.keys():
                embed.insert_field_at(
                    index=0,
                    name=key.title(),
                    value=str(value).title() + relevant_fields[key],
                    inline=True,
                )
        embed.description = content.get("overview", "No Description")
        embed.set_footer(
            text=f"Result {self.current_index+1} of {len(self.content_list)}"
        )
        await self.change_button("prev", self.current_index == 0)
        await self.change_button(
            "next", self.current_index == len(self.content_list) - 1
        )
        file_exists = bool(content.get("path", False))
        if file_exists:
            embed.insert_field_at(
                index=1,
                name="Unavailable To Request",
                value="Already exists on server.",
            )
        await self.change_button("select", file_exists)
        await self.manage_trailer_button(
            self.config.is_trailers_enabled and content.get("youTubeTrailerId", False)
        )
        self.embed = embed
        if not interaction:
            return embed
        await interaction.response.edit_message(embed=embed, view=self)


class ApproveNewUser(discord.ui.View):
    def __init__(self, context, response_object, auth_users, reason):
        self.context = context
        self.config = context.get("config", {})
        super().__init__(timeout=self.config.session_timeout)
        self.response = response_object
        self.authorized_users = auth_users
        self.prompt = reason
        self.embed = None

    async def on_timeout(self) -> None:
        self.result = "TIMED_OUT"
        await self.generate_embed(timed_out=True)
        await self.reply.edit(embed=self.embed, view=None)
        return await super().on_timeout()

    @discord.ui.button(
        label="Register User",
        style=discord.ButtonStyle.blurple,
        custom_id="register_user",
        row=0,
    )
    async def register_user_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user not in self.authorized_users:
            return
        self.result = "REGISTER_USER"
        await self.generate_embed(interaction)
        self.stop()

    @discord.ui.button(
        label="Register Admin",
        style=discord.ButtonStyle.green,
        custom_id="register_admin",
        row=0,
    )
    async def register_admin_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user not in self.authorized_users:
            return
        self.result = "REGISTER_ADMIN"
        await self.generate_embed(interaction)
        self.stop()

    @discord.ui.button(
        label="Deny", style=discord.ButtonStyle.gray, custom_id="deny", row=0
    )
    async def select_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user not in self.authorized_users:
            return
        self.result = "DENIED"
        await self.generate_embed(interaction)
        self.stop()

    async def generate_embed(self, interaction=False, timed_out=False):
        if not self.authorized_users:
            embed = discord.Embed(
                title="Authorization Required", color=discord.Color.brand_red()
            )
            embed.description = (
                "Authorization is required for this action, but no admin users exist in this server.\n\n"
                + "Please add/designate an admin user in the web-ui (where you started this bot).\n\n"
                + "If you continue to encounter errors like this, consider submitting a bug-report:\n\n"
                + "*Here*: https://discord.gg/wXs6z922VG\n*or*\n*Here*: https://github.com/nickheyer/DiscoFlix/issues/new"
            )
            embed.url = "https://discord.gg/wXs6z922VG"
            self.clear_items()
            self.embed = embed
            self.result = False
            self.stop()
            return embed
        elif timed_out:
            embed = discord.Embed(
                title="Authorization Timed-Out", color=discord.Color.brand_red()
            )
            embed.description = "No responses provided, moving on."
            self.embed = embed
            return embed
        elif not interaction:
            embed = discord.Embed(
                title="Authorization Required", color=discord.Color.dark_embed()
            )
            embed.description = self.prompt
            self.embed = embed
            return embed
        final_color = None
        final_title = None
        if self.result in ["DENIED"]:
            final_color = discord.Color.brand_red()
            final_title = "Authorization Denied"
        else:
            final_color = discord.Color.brand_green()
            final_title = "Authorization Granted"
        embed = discord.Embed(title=final_title, color=final_color)
        embed.description = (
            f"Decided By: {interaction.user.mention}\nOutcome: {self.result}"
        )
        await interaction.response.edit_message(embed=embed, view=None)

    async def send_response(self):
        await self.generate_embed()
        if self.authorized_users:
            self.reply = await self.response.channel.send(embed=self.embed, view=self)
            return await self.wait()
        self.reply = await self.response.channel.send(embed=self.embed)


class ApproveRequest(discord.ui.View):
    def __init__(self, context, response_object, reason, original_embed):
        self.context = context
        self.config = context.get("config", {})
        super().__init__(timeout=self.config.session_timeout)
        self.response = response_object
        self.authorized_users = self.get_admins(self.response)
        self.prompt = reason
        self.embed = None
        self.result = None
        self.original_embed = original_embed

    async def on_timeout(self) -> None:
        self.result = False
        await self.generate_embed(timed_out=True)
        await self.reply.edit(content=None, embed=None, view=None)
        return await super().on_timeout()

    def get_admins(self, message_object):
        users = get_users_in_server(message_object.guild.id, ["admin"])
        discord_users = []
        for user in users:
            user = message_object.guild.get_member_named(user)
            if user:
                discord_users.append(user)
        return discord_users

    def get_admin_mentions(self):
        message_template = ""
        for user in self.authorized_users:
            message_template += f"{user.mention}\n"
        return message_template

    @discord.ui.button(
        label="Approve", style=discord.ButtonStyle.green, custom_id="approve", row=0
    )
    async def register_admin_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user not in self.authorized_users:
            return
        self.result = True
        await interaction.response.edit_message(
            content=None, view=None, embed=self.original_embed
        )
        self.stop()

    @discord.ui.button(
        label="Deny", style=discord.ButtonStyle.red, custom_id="deny", row=0
    )
    async def select_button(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if interaction.user not in self.authorized_users:
            return
        self.result = False
        embed = discord.Embed(title="Request Denied", color=discord.Color.brand_red())
        embed.description = f"Decided By: {interaction.user.mention}\nOutcome: Denied"
        await interaction.response.edit_message(content=None, view=None, embed=embed)
        self.stop()

    async def generate_embed(self, interaction=False, timed_out=False):
        if not self.authorized_users:
            embed = discord.Embed(
                title="Authorization Required", color=discord.Color.brand_red()
            )
            embed.description = (
                "Authorization is required for this action, but no admin users exist in this server.\n\n"
                + "Please add/designate an admin user in the web-ui (where you started this bot).\n\n"
                + "If you continue to encounter errors like this, consider submitting a bug-report:\n\n"
                + "*Here*: https://discord.gg/wXs6z922VG\n*or*\n*Here*: https://github.com/nickheyer/DiscoFlix/issues/new"
            )
            embed.url = "https://discord.gg/wXs6z922VG"
            self.clear_items()
            self.embed = embed
            self.result = False
            self.stop()
            return embed
        elif not interaction:
            embed = discord.Embed(
                title="Authorization Required", color=discord.Color.dark_purple()
            )
            embed.description = self.prompt
            self.embed = embed
            return embed


class ListCommands():
    def __init__(self, context, message_object, message_map):
        self.context = context
        self.config = context.get("config", {})
        self.prefix = self.config.prefix_keyword
        self.response = message_object
        self.message_map = message_map
        self.user = message_object.author
        self.user_str = str(self.user)
        self.embed = None

    def generate_embed(self):
        embed = discord.Embed(title="Help", description="List of available commands:", color=self.user.color)
        user_roles = set(eval_user_roles(self.user_str))
        for command, command_info in self.message_map.items():
            required_roles = set(command_info['permissions'])
            if not required_roles or required_roles.intersection(user_roles):
                aliases = ', '.join(command_info['aliases'])
                usage = f"{self.prefix} {command_info['aliases'][0]}" + (' <' + command_info['args']['primary']['ref'] + '>' if command_info['args']['primary']['used'] else '')
                for additional_arg in command_info['args']['additional']:
                    usage += f" [{additional_arg['aliases'][0]}]" if not additional_arg['required'] else f" <{additional_arg['aliases'][0]}>"
                description = command_info.get('description', None)
                embed.add_field(name=f"{command.title()} ({aliases})", value=f"Usage: `{usage}`" + (f"\nDescription: `{description}`" if description else ""), inline=False)
        
        self.embed = embed
        return embed