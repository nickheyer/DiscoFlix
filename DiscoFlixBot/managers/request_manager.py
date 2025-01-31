from DiscoFlixBot.lib.api.radarr import RadarrAPI
from DiscoFlixBot.lib.api.sonarr import SonarrAPI
from DiscoFlixBot.managers.ui_manager import ContentSelectionView, ApproveRequest
from DiscoFlixClient.utils import (
    get_user,
    create_media,
    create_media_request,
    get_discord_server_from_id,
    save_instance,
    update_config
)

from discord import Embed
from asyncio import sleep
from datetime import datetime

# REQUEST HANDLER: Takes over after message containing request was receieved

class RequestHandler:
    radarr_session = sonarr_session = None

    def __init__(self, context) -> None:
        self.options = context
        self.request = context.primary
        self.request_type = context.command.name
        self.config = context.config
        self.message = context.message
        self.author = self.message.author
        self.logger = context.bot.send_log
        self.quality_profile = 1

    async def validate_request(self):
        self.user = await get_user(username=str(self.author))

        if not self._define_request_methods():
            return False

        await self._log_request(self.author, self.request, "requested")
        return True

    async def _get_or_create_tag(self, request_type):
        tag_id = -1
        tag_label = getattr(self.config, 'tag_label', 'DF')
        if not self.request_method or not self.config.is_tagging_enabled:
            tag_id = -1
        elif request_type == "movie":
            self.config.radarr_tag_id = self.request_method.get_or_create_tag(tag_label)
            await update_config({ "radarr_tag_id": self.config.radarr_tag_id })
            tag_id = self.config.radarr_tag_id
        elif request_type == "show":
            self.config.sonarr_tag_id = self.request_method.get_or_create_tag(tag_label)
            await update_config({ "sonarr_tag_id": self.config.sonarr_tag_id })
            tag_id = self.config.sonarr_tag_id
        return tag_id

    def _define_request_methods(self):
        self.request_method = None
        try:
            if self.request_type == "movie":
                if not RequestHandler.radarr_session:
                    self.request_method = RadarrAPI(
                        self.config.radarr_url, self.config.radarr_token
                    )
                    RequestHandler.radarr_session = self.request_method
                else:
                    self.request_method = RequestHandler.radarr_session
                self.get_content_list = self.request_method.lookup_movie
                self.get_info = self.request_method.get_movie

                def selector_fn(*args, **kwargs):
                    kwargs.setdefault('monitored', True)
                    kwargs.setdefault('searchForMovie', True)
                    return self.request_method.add_movie(*args, **kwargs)

                self.select_content = selector_fn
                self.id_key = "tmdbId"
                
                def get_existing_id_fn(remote_id):
                    return self.request_method.get_movie(None, remote_id)
                
                self.get_existing_id = get_existing_id_fn

            elif self.request_type == "show":
                if not RequestHandler.sonarr_session:
                    self.request_method = SonarrAPI(
                        self.config.sonarr_url, self.config.sonarr_token
                    )
                    RequestHandler.sonarr_session = self.request_method
                else:
                    self.request_method = RequestHandler.sonarr_session
                self.get_content_list = self.request_method.lookup_series
                self.get_info = self.request_method.get_series

                def selector_fn(*args, **kwargs):
                    kwargs.setdefault('monitored', True)
                    kwargs.setdefault('searchForMissingEpisodes', True)
                    return self.request_method.add_series(*args, **kwargs)

                self.select_content = selector_fn
                self.id_key = "tvdbId"
                
                def get_existing_id_fn(remote_id):
                    return self.request_method.get_series(f'?{self.id_key}={remote_id}')
                
                self.get_existing_id = get_existing_id_fn
                
            self.get_root_dirs = self.request_method.get_root
            self.force_search = self.request_method.force_search
        except Exception as e:
            self.request_method = None
        return self.request_method

    async def _record_request(self):
        self.media = await create_media(self.selected_content)
        self.request_object = await create_media_request(
            self.user,
            self.media,
            await get_discord_server_from_id(self.message.guild.id),
            self.message.content,
            self.request,
            self.request_type,
        )

    async def _respond(self, *args, **kwargs):
        return await self.message.channel.send(*args, **kwargs)

    async def _edit_response(self, *args, **kwargs):
        return await self.response.edit(*args, **kwargs)

    async def _log_request(self, author, request, action="requested"):
        await self.logger(f'{author} {action}: "{request}"')

    async def _cycle_content(self):
        self.max_results = self.config.max_results
        if (
            not self.max_results
            or self.max_results < 1
            or self.max_results > len(self.results)
        ):
            self.max_results = len(self.results)
        self.results = self.results[: self.max_results]
        self.view = ContentSelectionView(
            self.options, self.results, self.author, self.response
        )
        await self.view.async_init()
        self.embed = await self.view.update_embed()
        await self._edit_response(content=None, embed=self.embed, view=self.view)
        self.view.timed_out = await self.view.wait()
        return self.view.result

    async def _generate_success_message(self):
        emb = Embed(
            color=0x966FD6, title="New Content Available", timestamp=datetime.now()
        )
        emb.description = f"`{self.selected_content['title']}` is now available on `{self.config.media_server_name}`"
        await self.response.reply(
            content=f"{self.author.mention} :arrow_heading_down:", embed=emb
        )

    async def _monitor_download(self):
        STATUS_MAP = {
            "OVERRIDE": (
                "Existing and/or monitored content requested",
                "https://img.icons8.com/external-smashingstocks-glyph-smashing-stocks/66/null/external-new-email-mailing-smashingstocks-glyph-smashing-stocks.png",
            ),
            "FAILED": (
                "Request from server failed",
                "https://img.icons8.com/emoji/48/null/cross-mark-emoji.png",
            ),
            "ACKNOWLEDGED": (
                "Server acknowledged request",
                "https://img.icons8.com/external-smashingstocks-glyph-smashing-stocks/66/null/external-new-email-mailing-smashingstocks-glyph-smashing-stocks.png",
            ),
            "CHECK_SKIPPED": (
                "Monitoring not enabled for this request",
                "https://img.icons8.com/external-febrian-hidayat-glyph-febrian-hidayat/64/null/external-disabled-ui-essential-febrian-hidayat-glyph-febrian-hidayat.png",
            ),
            "SUCCESS": (
                f"Request fulfilled - content available on {self.config.media_server_name}",
                "https://img.icons8.com/ios-filled/50/null/winner.png",
            ),
            "FILE_FOUND": (
                "File found - attempting to download",
                "https://img.icons8.com/ios-filled/50/null/send-file.png",
            ),
            "SEARCHING": (
                "Searching indexers for a suitable download",
                "https://img.icons8.com/plasticine/100/null/search-more.png",
            ),
            "TIMED_OUT": (
                f"Monitoring for this request has timed out - continue to check {self.config.media_server_name} for updates",
                "https://img.icons8.com/ios-filled/50/null/time-machine.png",
            ),
        }

        if self.config.is_tagging_enabled:
            await self.view.update_tag(self.config.tag_label)
        if not self.download_response:
            await self.view.update_status(*STATUS_MAP["FAILED"])
            return False
        
        if self.view.was_forced:
            await self.view.update_status(*STATUS_MAP["OVERRIDE"])
        elif not hasattr(self.config, "max_check_time") or self.config.max_check_time < 1:
            await self.view.update_status(*STATUS_MAP["CHECK_SKIPPED"])
            return False
        else:
            await self.view.update_status(*STATUS_MAP["ACKNOWLEDGED"])
        
        # STARTING MONITORING
        current_time_waited = 0
        wait_interval = 10
        max_time_waited = self.config.max_check_time
        content_info = content_status = new_content_status = None
        self.init_size =0
        while current_time_waited <= max_time_waited:
            await sleep(wait_interval)
            content_info = self.get_info(self.databaseId)
            
            if self.view.was_forced and self.init_size == 0:
                self.init_size = content_info.get("sizeOnDisk", 0)

            if self.request_type == "movie":
                content_history = self.request_method.get_history_movie(self.databaseId)
                last_entry = content_history[0] if len(content_history) > 0 else {}
                if self.view.was_forced:
                    if (content_info.get("sizeOnDisk", 0) != self.init_size and
                        self.init_size > 0 and
                        content_info.get("hasFile", False)
                    ):
                        await self.view.update_status(*STATUS_MAP["SUCCESS"])
                        await self._generate_success_message()

                        self.request_object.status = True
                        await save_instance(self.request_object)
                        self.media.path = content_info.get("path", None)
                        await save_instance(self.media)
                        return True
                    elif last_entry.get("eventType", None) == "grabbed":
                        target_size = int(last_entry.get("data", {}).get("size", "0"))
                        new_content_status = (
                            f"Replacement File found - downloading ({round(target_size/(1024*1024), 2) if target_size != 0 else 0} MB)",
                            "https://img.icons8.com/ios-filled/50/null/send-file.png",
                        )
                elif content_info.get("hasFile", False):
                    await self.view.update_status(*STATUS_MAP["SUCCESS"])
                    await self._generate_success_message()

                    self.request_object.status = True
                    await save_instance(self.request_object)
                    self.media.path = content_info.get("path", None)
                    await save_instance(self.media)
                    return True
                elif content_info.get("sizeOnDisk", 0) != 0:
                    new_content_status = (
                        f'File found - downloading ({int(content_info["sizeOnDisk"])/(1024*1024)} MB)',
                        "https://img.icons8.com/ios-filled/50/null/send-file.png",
                    )
                elif last_entry.get("eventType", None) == "grabbed":
                    size = int(last_entry.get("data", {}).get("size", "0"))
                    new_content_status = (
                        f"File found - downloading ({round(size/(1024*1024), 2) if size != 0 else 0} MB)",
                        "https://img.icons8.com/ios-filled/50/null/send-file.png",
                    )
                else:
                    new_content_status = STATUS_MAP["SEARCHING"]
                    
            elif self.request_type == "show":
                seasons = content_info.get("seasonCount", None)
                episodes = content_info.get("episodeCount", 0)
                episode_files = content_info.get("episodeFileCount", 0)
                if episodes != episode_files:
                    new_content_status = (
                        f'{episode_files} / {episodes} episodes downloaded{(" (" + str(seasons) + " Season" + ("s" if seasons > 1 else "") + ")") if seasons else ""}',
                        "https://img.icons8.com/ios/50/null/progress-indicator.png",
                    )
                elif 0 not in [episode_files, episodes]:
                    new_content_status = (
                        f"All episodes downloaded and available ({episode_files} / {episodes})",
                        "https://img.icons8.com/ios-filled/50/null/winner.png",
                    )
                    await self.view.update_status(*new_content_status)
                    await self._generate_success_message()
                    return True
            if content_status != new_content_status:
                await self.view.update_status(*new_content_status)
                content_status = new_content_status
            else:
                current_time_waited += wait_interval

        await self.view.update_status(*STATUS_MAP["TIMED_OUT"])
        return False

    async def process_request(self):
        self.response = await self._respond(
            content=f"Searching for `{self.request}`...\nOne moment please."
        )
        self.results = self.get_content_list(self.request)
        if not self.results:
            await self._edit_response(
                content=f"Unfortunately, the {self.request_type} `{self.request}` is not available at this time."
            )
            return False
        self.selected_content = await self._cycle_content()
        if self.selected_content and self.view.approval_required:
            # REQUIRES ADMIN APPROVAL, CREATE APPROVAL VIEW
            
            # I need to add in a dynamically created rejection str here
            approval_view = ApproveRequest(
                self.options,
                self.response,
                'User is not authorized to make this request.',
                self.embed,
            )
            await approval_view.async_init()
            emb = await approval_view.generate_embed()
            await self._edit_response(
                content=approval_view.get_admin_mentions(),
                embed=emb,
                view=approval_view,
            )
            is_timed_out = await approval_view.wait()
            if is_timed_out or not approval_view.result:
                self.selected_content = None
                await self.response.delete()
                return False
        if not self.selected_content:
            await self.logger(f"{self.author} was unable to finish their request.")
            if not self.view.timed_out and not self.view.approval_required:
                await self.response.delete()
            return False
        await self._record_request()
        self.remoteId = self.selected_content[self.id_key]
        await self.view.content_selected()
        await self.message.delete()
        # WHERE THE DOWNLOAD BEGINS
        self.download_dir = f'{self.get_root_dirs()[0]["path"]}/'

        opt_kwargs = {}
        self.tag_id = await self._get_or_create_tag(self.request_type)
        if self.tag_id != -1:
            opt_kwargs['tag_id'] = self.tag_id

        if self.view.was_forced:
            existing_res = self.get_existing_id(self.remoteId)
            if len(existing_res) == 0:
                return False
            existing_info = existing_res[0]
            self.databaseId = existing_info.get('id', False)
            self.download_response = self.force_search(self.databaseId)
        else:
            self.download_response = self.select_content(
                self.remoteId, self.quality_profile, self.download_dir, **opt_kwargs
            )
            self.databaseId = self.download_response.get('id', False)

        if not self.download_response:
            return False
        await self.logger(
            f'Downloading {self.selected_content["title"]} to {self.download_dir}'
        )
        
        self.monitor_outcome = await self._monitor_download()
        if not self.monitor_outcome:
            await self.logger(f'Download ({self.selected_content["title"]}) timed-out.')
            return False
        else:
            await self.logger(f'Download ({self.selected_content["title"]}) succeeded.')
            return True
