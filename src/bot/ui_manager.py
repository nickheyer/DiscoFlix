import discord

from bot.user_manager import eval_user_roles
from lib.utils import generate_debug_file

class ContentSelectionView(discord.ui.View):
    def __init__(self, context, content_list, author, response_object):
        super().__init__(timeout=None)
        self.context = context
        self.config = context.get('config', {})
        self.author = author
        self.user_roles = eval_user_roles(str(author))
        self.content_list = content_list
        self.response_object = response_object
        self.current_index = 0
        self.result = None
        self.embed = None
        if 'developer' in self.user_roles and self.config.is_debug:
            self._dev_debug_helpers()

    def _dev_debug_helpers(self):
        details = discord.ui.Button(label='Details', style=discord.ButtonStyle.secondary, custom_id='details', row=1)
        details.callback = self.debug_details_button_callback
        self.add_item(details)

    async def debug_details_button_callback(self, interaction):
        if interaction.user.id != self.author.id:
            return
        file_path = generate_debug_file(self.content_list[self.current_index])
        file = discord.File(file_path, filename='debug.json')
        await interaction.response.send_message(content='_DEBUG_:', file=file)

    @discord.ui.button(label="<< Previous", style=discord.ButtonStyle.blurple, custom_id="prev", disabled=True, row=0)
    async def previous_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.author.id:
            return
        if self.current_index > 0:
            self.current_index -= 1
            await self.update_embed(interaction)

    @discord.ui.button(label="Select", style=discord.ButtonStyle.green, custom_id="select", row=0)
    async def select_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.author.id:
            return
        await interaction.response.defer()
        self.result = self.content_list[self.current_index]
        self.stop()

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.red, custom_id="cancel", row=0)
    async def cancel_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.author.id:
            return
        await interaction.response.defer()
        self.stop()

    @discord.ui.button(label="Next >>", style=discord.ButtonStyle.blurple, custom_id="next", row=0)
    async def next_button(self, interaction: discord.Interaction, button: discord.ui.Button):
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
    
    async def update_requestor(self):
        self.embed.set_author(
            name=self.author,
            icon_url=self.author.display_avatar.url
        )
        self.embed.color = self.author.colour

    async def update_status(self, request_status, icon_url, update_embed = True):
        self.embed.set_footer(icon_url=icon_url, text=request_status)
        if update_embed:
            await self.response_object.edit(
                content=None,
                embed=self.embed,
                view = None
            )

    async def content_selected(self):
        await self.update_requestor()
        await self.update_status(
            request_status=f'Requested from server',
            icon_url='https://img.icons8.com/dotty/80/null/submit-progress.png',
            update_embed=False)
        await self.response_object.edit(
            content=None,
            embed=self.embed,
            view = None
        )

    async def update_embed(self, interaction = False):
        content = self.content_list[self.current_index]
        embed = discord.Embed(
            title=f"{content.get('title', 'Unitled')}" + f' ({content["year"]})' if ('year' in content and content['year'] not in content.get('title', '')) else '',
            color=0x966FD6,
            url=content.get('website', None))
        embed.set_image(url=content.get('remotePoster', 'https://i.imgur.com/1glpRCZ.png?1'))
        embed.description = content.get('overview', 'No Description')
        embed.set_footer(text=f'Result {self.current_index+1} of {len(self.content_list)}')
        await self.change_button('prev', self.current_index == 0)
        await self.change_button('next', self.current_index == len(self.content_list) - 1)
        if content.get('path', None):
            embed.insert_field_at(index=1, name='Unavailable To Request', value='Already exists on server.')
        await self.change_button('select', content.get('path', None))
        self.embed = embed
        if not interaction:
            return embed
        await interaction.response.edit_message(embed=embed, view=self)