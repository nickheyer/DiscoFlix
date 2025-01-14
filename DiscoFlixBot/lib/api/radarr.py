from urllib.parse import quote_plus
from DiscoFlixBot.lib.api.requests import RequestAPI
from typing import Optional, Union, Dict
from datetime import datetime


class RadarrAPI(RequestAPI):
    def __init__(self, host_url: str, api_key: str):
        """Constructor requires Host-URL and API-KEY

        Args:
            host_url (str): Host URL to radarr.
            api_key (str): API key from Radarr.
        """
        super().__init__(host_url, api_key)
        self.base = "/api/v3"

    def get_movie(
        self, dbId: Optional[int] = None, tmdbid: Optional[Union[int, str]] = None
    ) -> Optional[dict]:
        """Get information on all movies or a specific movie in the collection.

        Args:
            dbId (int, optional): Database ID of the movie to get. Defaults to None.
            tmdbid (int, str, optional): TMDb ID of the movie to get. Defaults to None.

        Returns:
            dict or None: JSON response or None in case of an error.
        """

        path = f"{self.base}/movie"

        if dbId:
            path += f"/{dbId}"
        elif tmdbid:
            path += f"?tmdbId={int(tmdbid)}"

        return self.request_get(path)

    def lookup_movie(self, term: str) -> Optional[dict]:
        """Search for a movie using a search term.

        Args:
            term (str): Search term to use in the lookup.

        Returns:
            dict or None: JSON response or None in case of an error.
        """
        term = quote_plus(term)
        path = f"{self.base}/movie/lookup?term={term}"

        return self.request_get(path)

    def lookup_movie_by_tmdb_id(self, term: Union[int, str]) -> Optional[dict]:
        """Lookup a movie using its TMDb ID.

        Args:
            term (int, str): The TMDb ID to use in the lookup.

        Returns:
            dict or None: JSON response or None in case of an error.
        """
        path = f"{self.base}/movie/lookup/tmdb?tmdbId={term}"

        return self.request_get(path)

    def get_root(self) -> Optional[dict]:
        """Get the root folder information.

        Returns:
            dict or None: JSON response or None in case of an error.
        """
        path = f"{self.base}/rootfolder"

        return self.request_get(path)

    def get_quality_profiles(self) -> Optional[dict]:
        """Get quality profiles information.

        Returns:
            dict or None: JSON response or None in case of an error.
        """
        path = f"{self.base}/qualityProfile"

        return self.request_get(path)

    def construct_movie_json(
        self,
        dbId: str,
        qualityProfileId: int,
        rootDir: str,
        monitored: bool = True,
        searchForMovie: bool = True,
    ) -> Dict:
        """
        Searches for a movie on TMDb and returns Movie JSON to add.

        Args:
            dbId (str): TMDb or IMDb ID of the movie.
            qualityProfileId (int): Quality profile ID.
            rootDir (str): Root directory for the movie files.
            monitored (bool, optional): Whether the movie is monitored. Defaults to True.
            searchForMovie (bool, optional): Whether to search for the movie. Defaults to True.

        Returns:
            dict: JSON representation of the movie.

        Raises:
            Exception: If the movie does not exist.
        """
        s_dict = self.lookup_movie(dbId)

        if not s_dict:
            raise Exception("Movie doesn't exist")

        movie_json = {
            "title": s_dict[0]["title"],
            "rootFolderPath": rootDir,
            "qualityProfileId": qualityProfileId,
            "year": s_dict[0]["year"],
            "tmdbId": s_dict[0]["tmdbId"],
            "images": s_dict[0]["images"],
            "titleSlug": s_dict[0]["titleSlug"],
            "monitored": monitored,
            "addOptions": {"searchForMovie": searchForMovie},
        }
        return movie_json

    def add_movie(
        self,
        dbId: str,
        qualityProfileId: int,
        rootDir: Optional[str] = None,
        monitored: bool = True,
        searchForMovie: bool = True,
        tag_id=None
    ) -> Dict:
        """
        Adds a new movie to the collection.

        Args:
            dbId (str): TMDb ID of the movie.
            qualityProfileId (int): Quality profile ID.
            rootDir (str, optional): Root directory for the movie files. If not specified, the default root directory is used.
            monitored (bool, optional): Whether the movie is monitored. Defaults to True.
            searchForMovie (bool, optional): Whether to search for the movie. Defaults to True.

        Returns:
            dict: JSON response from the API.
        """
        if not rootDir:
            rootDir = self.get_root()[0]["path"]

        term = f"tmdb:{str(dbId)}"
        movie_json = self.construct_movie_json(
            term, qualityProfileId, rootDir, monitored, searchForMovie
        )

        if tag_id is not None:
            movie_json['tags'] = [tag_id]
            print(f'Added Tag to Content: [{tag_id}]')

        path = f"{self.base}/movie"
        response = self.request_post(path, data=movie_json)
        return response

    def update_movie(self, data: Dict) -> Dict:
        """
        Updates an existing movie.

        Args:
            data (dict): Data of the movie to update, obtained from the get_movie method.

        Returns:
            dict: JSON response from the API.
        """
        path = f"{self.base}/movie"
        response = self.request_put(path, data)
        return response

    def del_movie(
        self, movieId: int, delFiles: bool = False, addExclusion: bool = False
    ) -> Dict:
        """
        Deletes a single movie by its database ID.

        Args:
            movieId (int): Database ID of the movie to delete.
            delFiles (bool, optional): Whether to delete files associated with the movie. Defaults to False.
            addExclusion (bool, optional): Whether to add the movie to the exclusion list. Defaults to False.

        Returns:
            dict: JSON response from the API.
        """
        data = {"deleteFiles": delFiles, "addExclusion": addExclusion}
        path = f"{self.base}/movie/{movieId}"
        response = self.request_delete(path, data)
        return response

    # TODO: PUT Movie Editor
    # TODO: DELETE Movie Editor
    # TODO: POST Movie import

    # Movie Files
    def get_movie_file(self, movieId):
        """Returns movie files"""

        path = f"{self.base}/moviefile/{movieId}"
        res = self.request_get(path)
        return res

    def del_movie_file(self, movieId):
        """Allows for deletion of a moviefile by its database id.
        Args:
            Required - movieId (int)
        Returns:
            json response

        """
        path = f"{self.base}/movie/{movieId}"
        res = self.request_delete(path)
        return res

    # history
    def get_history(
        self, page=1, pageSize=20, sortKey="date", sortDirection="descending"
    ):
        """Return a json object list of items in your history

        Args:
            Required - page (int) - Default: 1
            Required - pageSize (int) - Default: 20
            Required - sortKey (string) - Default: date
            Required - sortDir (string) - Default: descending
        Returns:
            json response
        """
        path = f"{self.base}/history?page={page}&pageSize={pageSize}&sortDirection={sortDirection}&sortKey={sortKey}"
        res = self.request_get(path)
        return res

    def get_history_movie(self, movieId, eventType=None):
        """Return a json object list of items in your history

        Args:
            Required - movieId (int) (Database id of movie)
            Optional - eventType (int) (History event type to retrieve)
        Returns:
            json response
        """
        path = f"{self.base}/history/movie?movieId={movieId}"
        if eventType:
            path += f"&eventType={eventType}"
        res = self.request_get(path)
        return res

    # blacklist
    # TODO: GET blacklist
    # TODO: DELETE blacklist
    # TODO: GET blacklist movie
    # TODO: DELETE Blacklist Bulk

    # queue
    def get_queue(
        self,
        page=1,
        pageSize=20,
        sortKey="timeLeft",
        sortDirection="ascending",
        includeUnknownMovieItems="true",
    ):
        """Return a json object list of items in the queue"""
        path = f"{self.base}/queue?page={page}&pageSize={pageSize}&sortDirection={sortDirection}&sortKey={sortKey}&includeUnknownMovieItems={includeUnknownMovieItems}"

        res = self.request_get(path)
        return res

    # indexer
    def get_indexer(self, id=None):
        """Get all indexers or a single indexer by its database id

        Args:
            Optional - id (int)
        Returns:
            json response
        """

        path = f"{self.base}/indexer"

        if id:
            path += f"/{id}"

        res = self.request_get(path)
        return res

    # TODO: look into this, documentation lacking
    def put_indexer(self, id):
        """Edit an indexer"""
        path = f"{self.base}/indexer/{id}"
        res = path.request_put(path)
        return res

    def del_indexer(self, id):
        """Delete and indexer

        Args:
            Required - id (int)
        Returns:
            json response
        """
        path = f"{self.base}/indexer/{id}"
        res = self.request_delete(path)
        return res

    # Download client
    def get_downloadclient(self, id=None):
        """Get all download clients or a single download client by its database id

        Args:
            Optional - id (int)
        Returns:
            json response
        """

        path = f"{self.base}/downloadclient"

        if id:
            path += f"/{id}"

        res = self.request_get(path)
        return res

    # TODO: look into this, documentation lacking
    def put_downloadclient(self, id):
        """Edit an downloadclient"""
        path = f"{self.base}/downloadclient/{id}"
        res = path.request_put(path)
        return res

    def del_downloadclient(self, id):
        """Delete an downloadclient

        Args:
            Required - id (int)
        Returns:
            json response
        """
        path = f"{self.base}/downloadclient/{id}"
        res = self.request_delete(path)
        return res

    # Import Lists
    def get_importlist(self, id=None):
        """Get all import lists or a single import list by its database id

        Args:
            Optional - id (int)
        Returns:
            json response
        """

        path = f"{self.base}/importlist"
        if id:
            path += f"/{id}"

        res = self.request_get(path)
        return res

    # TODO: look into this, documentation lacking
    def put_importlist(self, id):
        """Edit an importlist"""
        path = f"{self.base}/importlist/{id}"
        res = path.request_put(path)
        return res

    def del_importlist(self, id):
        """Delete an importlist

        Args:
            Required - id (int)
        Returns:
            json response
        """
        path = f"{self.base}/importlist/{id}"
        res = self.request_delete(path)
        return res

    # Notification
    def get_notification(self, id=None):
        """Get all notifications or a single notification by its database id

        Args:
            Optional - id (int)
        Returns:
            json response
        """
        path = f"{self.base}/notification"
        if id:
            path += f"/{id}"

        res = self.request_get(path)
        return res

    # TODO: look into this, documentation lacking
    def put_notification(self, id):
        """Edit a notification"""
        path = f"{self.base}/notification/{id}"
        res = path.request_put(path)
        return res

    def del_notification(self, id):
        """Delete a notification

        Args:
            Required - id (int)
        Returns:
            json response
        """
        path = f"{self.base}/notification/{id}"
        res = self.request_delete(path)
        return res

    # Tag
    def get_tags(self):
        """Query Radarr for tags

        Args:
            None
        Returns:
            json response

        """
        path = f"{self.base}/tag"
        res = self.request_get(path)
        return res

    def get_id_for_tag_name(self, tag_name):
        """Query Radarr for tags.
            Search returned tags for provided name.
            Return ID associated with name, 
            or return -1 if tag not found matching name.

        Args:
            Required - tag_name (str)
        Returns:
            int

        """
        res = self.get_tags()
        print(f'Available tags: {res}')
        for x in res:
            if tag_name.lower() in x.get('label', ''):
                return x.get('id', -1)
        return -1

    def create_tag(self, **kwargs):
        """Create a tag in Radarr with a specified tag name/label

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
        """Get existing tag or create a tag in Radarr with a specified tag name/label

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

    # diskspace
    def get_disk_space(self):
        """Query Radarr for disk usage information

            Location: System > Status

        Args:
            None
        Returns:
            json response

        """
        path = f"{self.base}/diskspace"
        res = self.request_get(path)
        return res

    # Settings
    def get_config_ui(self):
        """Query Radarr for UI settings"""
        path = f"{self.base}/config/ui"
        res = self.request_get(path)
        return res

    def get_config_host(self):
        """Get General/Host settings for Radarr."""
        path = f"{self.base}/config/host"
        res = self.request_get(path)
        return res

    def get_config_naming(self):
        """Get Settings for movie file and folder naming."""
        path = f"{self.base}/config/naming"
        res = self.request_get(path)
        return res

    def put_config_ui(self, data):
        """Edit one or many UI Settings and save to the database"""
        path = f"{self.base}/config/ui"
        res = self.request_put(path, data)
        return res

    def put_config_host(self, data):
        """Edit General/Host settings for Radarr."""
        path = f"{self.base}/config/host"
        res = self.request_put(path, data)
        return res

    def put_config_naming(self, data):
        """Edit Settings for movie file and folder naming."""
        path = f"{self.base}/config/naming"
        res = self.request_put(path, data)
        return res

    # metadata
    def get_metadata(self):
        """Get all metadata consumer settings"""
        path = f"{self.base}/metadata"
        res = self.request_get(path)
        return res

    # system
    def get_system_status(self):
        """Find out information such as OS, version, paths used, etc"""
        path = f"{self.base}/system/status"
        res = self.request_get(path)
        return res

    # health
    def get_health(self):
        """Query radarr for health information"""
        path = f"{self.base}/health"
        res = self.request_get(path)
        return res

    # command
    def post_command(self, **kwargs):
        """Performs any of the predetermined Radarr command routines.

        Kwargs:
            Required - name (string).

            Options available:
                - ApplicationUpdate - Trigger an update of Radarr
                - Backup - Trigger a backup routine
                - CheckHealth - Trigger a system health check
                - ClearBlacklist - Triggers the removal of all blacklisted movies
                - CleanUpRecycleBin - Trigger a recycle bin cleanup check
                - DeleteLogFiles - Triggers the removal of all Info/Debug/Trace log files
                - DeleteUpdateLogFiles - Triggers the removal of all Update log files
                - DownloadedMoviesScan - Triggers the scan of downloaded movies
                - MissingMoviesSearch - Triggers a search of all missing movies
                - RefreshMonitoredDownloads - Triggers the scan of monitored downloads
                - RefreshMovie - Trigger a refresh / scan of library
                    - movieIds:int[] - a list of ids (comma separated) for movies to refresh

            See https://radarr.video/docs/api/#/Command/post-command
        Returns:
        json response

        """
        path = f"{self.base}/command"

        data = kwargs
        res = self.request_post(path, data)
        return res

    def force_search(self, id: int) -> dict:
        """
        Forces a search of a currently monitored title, existing or otherwise.

        Args:
            id (int): Radarr Id of the movie.

        Returns:
            dict: JSON response from the API.
        """
        path = f"{self.base}/command"

        data = { "name": "MoviesSearch", "movieIds": [id] }
        res = self.request_post(path, data)
        return res

    # update
    def get_update(self):
        """Returns a list of recent updates to Radarr

        Location: System > Updates
        """
        path = f"{self.base}/update"
        res = self.request_get(path)
        return res

    def get_calendar(
        self,
        unmonitored: bool = True,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> Dict:
        """Get a list of movies based on calendar parameters.
        If start and end are not provided, retrieves movies airing today and tomorrow.

        args:
            unmonitored (bool, optional): Whether to include unmonitored movies. Defaults to True.
            start_date (datetime, optional): Start date in ISO 8601 format. Defaults to None.
            end_date (datetime, optional): End date in ISO 8601 format. Defaults to None.

        Returns:
            dict: JSON response.

        """
        params = {"unmonitored": str(unmonitored).lower()}

        if start_date is not None:
            params["start"] = start_date.strftime("%Y-%m-%d")
        if end_date is not None:
            params["end"] = end_date.strftime("%Y-%m-%d")

        path = f"{self.base}/calendar"
        res = self.request_get(path, **params)
        return res

    # custom filters
    def get_custom_filter(self):
        """Query Radarr for custom filters."""
        path = f"{self.base}/customfilter"
        res = self.request_get(path)
        return res

    # remote path mapping
    def get_remote_path_mapping(self):
        """Get a list of remote paths being mapped and used by Radarr"""
        path = f"{self.base}/remotePathMapping"
        res = self.request_get(path)
        return res
