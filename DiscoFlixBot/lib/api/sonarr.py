from datetime import datetime
from DiscoFlixBot.lib.api.requests import RequestAPI
from typing import Optional


class SonarrAPI(RequestAPI):
    def __init__(self, host_url: str, api_key: str):
        """Constructor requires Host-URL and API-KEY

        Args:
            host_url (str): Host url to sonarr.
            api_key (str): API key from Sonarr.
        """
        super().__init__(host_url, api_key)
        self.base = "/api/v3"

    def get_calendar(
        self, start_date: Optional[str] = None, end_date: Optional[str] = None
    ) -> dict:
        """Retrieves info about when series were/will be downloaded.
        If no start and end date are provided, retrieves series airing today and tomorrow.

        Args:
            start_date (str, optional): Start date in "YYYY-MM-DD" format. Defaults to None.
            end_date (str, optional): End date in "YYYY-MM-DD" format. Defaults to None.

        Returns:
            dict: JSON response
        """
        path = f"{self.base}/calendar"
        data = {}

        if start_date:
            data.update({"start": start_date})
        if end_date:
            data.update({"end": end_date})

        res = self.request_get(path, **data)
        return res

    def get_command(self, command_id: Optional[int] = None) -> dict:
        """Queries the status of a previously started command, or all currently started commands.

        Args:
            command_id (int, optional): Unique ID of command. Defaults to None.

        Returns:
            dict: JSON response
        """
        path = (
            f"{self.base}/command/{command_id}"
            if command_id is not None
            else f"{self.base}/command"
        )

        res = self.request_get(path)
        return res

    def set_command(self, **kwargs):
        """Performs any of the predetermined Sonarr command routines.

        Kwargs:
            Required - name (string).

            Options available: RefreshSeries, RescanSeries, EpisodeSearch,
                SeasonSearch, SeriesSearch, DownloadedEpisodesScan, RssSync,
                RenameFiles, RenameSeries, Backup, missingEpisodeSearch

            Additional Parameters may be required or optional...
            See https://github.com/Sonarr/Sonarr/wiki/Command
        Returns:
            json response

        """
        path = f"{self.base}/command"

        data = kwargs
        res = self.request_post(path, data)
        return res

    def get_disk_space(self):
        """Retrieves info about the disk space on the server.

        Args:
            None
        Returns:
            json response

        """
        path = f"{self.base}/diskspace"
        res = self.request_get(path)
        return res

    def get_episodes_by_series_id(self, seriesId):
        """Returns all episodes for the given series

        Args:
            seriesId (int):
        Returns:
            json response
        """
        path = f"{self.base}/episode?seriesId={seriesId}"
        res = self.request_get(path)
        return res

    def get_episode_by_episode_id(self, episodeId):
        """Returns the episode with the matching id

        Args:
            episode_id (int):
        Returns:
            json response
        """
        path = f"{self.base}/episode/{episodeId}"
        res = self.request_get(path)
        return res

    def lookup_series(self, term):
        """Searches for new shows on tvdb
        Args:
            Requried - term / tvdbId
        Returns:
            json response

        """
        term = str(term)
        if term.isdigit():
            term = f"tvdb:{term}"
        else:
            term = term.replace(" ", "%20")
        path = f"{self.base}/series/lookup?term={term}"
        res = self.request_get(path)
        return res

    def get_root(self):
        """Returns the Root Folder"""
        path = f"{self.base}/rootfolder"
        res = self.request_get(path)
        return res

    def get_quality_profiles(self):
        """Gets all quality profiles"""
        path = f"{self.base}/profile"
        res = self.request_get(path)
        return res

    def construct_series_json(
        self,
        tvdbId,
        qualityProfileId,
        rootDir,
        seasonFolder=True,
        monitored=True,
        ignoreEpisodesWithFiles=False,
        ignoreEpisodesWithoutFiles=False,
        searchForMissingEpisodes=False,
    ):
        """Searches for new shows on trakt and returns Series json to add

        Args:
            Required - tvdbID (int)
            Required - qualityProfileId (int)
            Required - rootDir (string)
            Optional - seasonFolder (boolean)
            Optional - monitored (boolean)
            Optional - ignoreEpisodesWithFiles (boolean)
            Optional - ignoreEpisodesWithoutFiles (boolean)
            Optional - searchForMissingEpisodes (boolean)

        Return:
            JsonArray

        """
        res = self.lookup_series(tvdbId)
        s_dict = res[0]
        if not monitored:
            for season in s_dict["seasons"]:
                season["monitored"] = False

        series_json = {
            "title": s_dict["title"],
            "seasons": s_dict["seasons"],
            "path": rootDir + s_dict["title"],
            "qualityProfileId": qualityProfileId,
            "seasonFolder": seasonFolder,
            "monitored": monitored,
            "tvdbId": tvdbId,
            "images": s_dict["images"],
            "titleSlug": s_dict["titleSlug"],
            "addOptions": {
                "ignoreEpisodesWithFiles": ignoreEpisodesWithFiles,
                "ignoreEpisodesWithoutFiles": ignoreEpisodesWithoutFiles,
                "searchForMissingEpisodes": searchForMissingEpisodes,
            },
        }
        return series_json

    def get_series(self, *args):
        """Return all series in your collection or
        the series with the matching ID if one is found
        Args:
            Optional - seriesID

        Returns:
            Json Array
        """
        if len(args) == 1:
            path = f"{self.base}/series/{args[0]}"
        else:
            path = f"{self.base}/series"

        res = self.request_get(path)
        return res

    def add_series(
        self,
        tvdbId,
        qualityProfileId,
        rootDir,
        seasonFolder=True,
        monitored=True,
        ignoreEpisodesWithFiles=False,
        ignoreEpisodesWithoutFiles=False,
        searchForMissingEpisodes=False,
        tag_id=None
    ):
        """Add a new series to your collection

        Args:
            Required - tvdbID (int)
            Required - qualityProfileId (int)
            Required - rootDir (string)
            Optional - seasonFolder (boolean)
            Optional - monitored (boolean)
            Optional - ignoreEpisodesWithFiles (boolean)
            Optional - ignoreEpisodesWithoutFiles (boolean)
            Optional - searchForMissingEpisodes (boolean)
        Returns:
            json response

        """
        series_json = self.construct_series_json(
            tvdbId,
            qualityProfileId,
            rootDir,
            seasonFolder,
            monitored,
            ignoreEpisodesWithFiles,
            ignoreEpisodesWithoutFiles,
            searchForMissingEpisodes,
        )

        if tag_id is not None:
            series_json['tags'] = [tag_id]
            print(f'Added Tag to Content: [{tag_id}]')

        path = f"{self.base}/series"
        res = self.request_post(path, data=series_json)
        return res

    def upd_series(self, data):
        """Update an existing series.

        Args:
            data (dictionary containing an object obtained by getSeries())
        Returns:
            json response
        """

        path = f"{self.base}/series"
        res = self.request_put(path, data)
        return res

    def force_search(self, id: int) -> dict:
        """
        Forces a search of a currently monitored series, existing or otherwise.

        Args:
            id (int): Sonarr Id of the series.

        Returns:
            dict: JSON response from the API.
        """
        path = f"{self.base}/command"

        data = {
        "name": "SeriesSearch",
        "seriesId": id
        }
        res = self.request_post(path, data)
        return res
    
    def del_series(self, seriesId, delFiles=False):
        """Delete the series with the given ID"""
        # File deletion does not work
        data = {"deleteFiles": delFiles}
        path = f"{self.base}/series/{seriesId}"
        res = self.request_delete(path, data)
        return res

    def get_system_status(self):
        """Returns the System Status as json"""
        path = f"{self.base}/system/status"
        res = self.request_get(path)
        return res

    def get_queue(self):
        """Gets current downloading info

        Returns:
            json Array
        """
        path = f"{self.base}/queue"
        res = self.request_get(path)
        return res

    # TODO: requires Test
    def del_queue(self, id, *args):
        """Deletes an item from the queue and download client.
        Optionally blacklist item after deletion.

        Args:
            Required - id (int)
            Optional - blacklist (bool)
        Returns:
            json response
        """
        data = {}
        data.update({"id": id})
        if len(args) == 1:
            data.update(
                {
                    "blacklist": args[1],
                }
            )
        path = f"{self.base}/queue/"
        res = self.request_delete(path, data)
        return res

    def get_wanted(self, **kwargs):
        """Gets Wanted / Missing episodes

        Args:
            Required - sortKey (string) - series.title or airDateUtc (default)
            Optional - page (int) - 1-indexed Default: 1
            Optional - pageSize (int) - Default: 10
            Optional - sortDir (string) - asc or desc - Default: asc
        Returns:
            json response
        """
        data = {}
        data.update({"sortKey": kwargs.get("sortKey", "airDateUtc")})
        for key, value in kwargs.items():
            data.update({key: value})
        path = f"{self.base}/wanted/missing"
        res = self.request_get(path, **data)
        return res

    def get_history(self, **kwargs):
        """Gets history (grabs/failures/completed)

        Args:
            Required - sortKey (string) - series.title or date (default)
            Optional - page (int) - 1-indexed
            Optional - pageSize (int) - Default: 0
            Optional - sortDir (string) - asc or desc - Default: asc
            Optional - episodeId (int) - Filters to a specific episode ID
        Returns:
            json response
        """
        data = {}
        data.update({"sortKey": kwargs.get("sortKey", "date")})
        for key, value in kwargs.items():
            data.update({key: value})
        path = f"{self.base}/history"
        res = self.request_get(path, **data)
        return res

    def get_logs(self, **kwargs):
        """Gets Sonarr Logs

        Kwargs;
            Required - None
            Optional - page (int) - Page number - Default: 1.
            optional - pageSize (int) - Records per page - Default: 10.
            optional - sortKey (str) - What key to sort on - Default: 'time'.
            optional - sortDir (str) - asc or desc - Default: desc.
            optional - filterKey (str) - What key to filter - Default: None.
            optional - filterValue (str) - Warn, Info, Error - Default: All.

        Returns:
            Json Array
        """
        data = {}
        for key, value in kwargs.items():
            data.update({key: value})
        path = f"{self.base}/log"
        res = self.request_get(path, **data)
        return res

    def get_backup(self):
        """Returns the backups as json"""
        path = f"{self.base}/system/backup"
        res = self.request_get(path)
        return res

    def upd_episode(self, data):
        """Update the given episodes, currently only monitored is changed, all
        other modifications are ignored. All parameters (you should perform a
        GET/{id} and submit the full body with the changes, as other values may
        be editable in the future.

            Args:
                data (dict): data payload

            Returns:
                json response
        """
        path = f"{self.base}/episode"
        res = self.request_put(path, data)
        return res

    # TODO: Test this
    def get_episode_files_by_series_id(self, series_id):
        """Returns all episode files for the given series

        Args:
            series_id (int):

        Returns:
            requests.models.Response: Response object form requests.
        """
        data = {"seriesId": series_id}
        path = f"{self.base}/episodefile"
        res = self.request_get(path, **data)
        return res

    # TODO: Test this
    def get_episode_file_by_episode_id(self, episode_id):
        """Returns the episode file with the matching id

        Kwargs:
            episode_id (int):

        Returns:
            requests.models.Response: Response object form requests.
        """
        path = f"{self.base}/episodefile/{episode_id}"
        res = self.request_get(path)
        return res

    def del_episode_file_by_episode_id(self, episode_id):
        """Delete the given episode file

        Kwargs:
            episode_id (str):

        Returns:
            requests.models.Response: Response object form requests.
        """
        path = f"{self.base}/episodefile/{episode_id}"
        res = self.request_delete(path, data=None)
        return res

    # TODO: Test this
    def push_release(self, **kwargs):
        """Notifies Sonarr of a new release.
        title: release name
        downloadUrl: .torrent file URL
        protocol: usenet / torrent
        publishDate: ISO8601 date string

        Kwargs:
            title (str):
            downloadUrl (str):
            protocol (str):
            publishDate (str):

        Returns:
            requests.models.Response: Response object form requests.
        """
        path = f"{self.base}/release/push"
        res = self.request_post(path, data=kwargs)
        return res


    def get_tags(self):
        """Query Sonarr for tags

        Args:
            None
        Returns:
            json response

        """
        path = f"{self.base}/tag"
        res = self.request_get(path)
        return res

    def get_id_for_tag_name(self, tag_name):
        """Query Sonarr for tags.
            Search returned tags for provided name.
            Return ID associated with name, 
            or return -1 if tag not found matching name.

        Args:
            Required - tag_name (str)
        Returns:
            int

        """
        res = self.get_tags()
        for x in res:
            if tag_name.lower() in x.get('label', ''):
                return x.get('id', -1)
        return -1

    def create_tag(self, **kwargs):
        """Create a tag in Sonarr with a specified tag name/label

        Args:
            None
        Returns:
            json response

        """
        path = f"{self.base}/tag"
        kwargs.setdefault('label', 'DF')
        kwargs.setdefault('id', 0)
        res = self.request_post(path, data=kwargs)
        return res

    def get_or_create_tag(self, tag_name="DF"):
        """Get existing tag or create a tag in Sonarr with a specified tag name/label

        Args:
            None
        Returns:
            int

        """
        existing = self.get_id_for_tag_name(tag_name)
        if existing != -1:
            return existing
        else:
            new = self.create_tag(label=tag_name)
            return new.get('id', -1)
        