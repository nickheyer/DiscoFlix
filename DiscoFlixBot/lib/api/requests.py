import requests
import logging

logger = logging.getLogger(__name__)


class RequestAPI:
    def __init__(self, host_url=None, api_key=None):
        """Constructor requires Host-URL and API-KEY

        Args:
            host_url (str): Host url to sonarr/radarr.
            api_key: API key from sonarr/radarr.
        """
        self.host_url = host_url
        self.api_key = api_key
        self.session = requests.Session()
        self.auth = None

    def basic_auth(self, username: str, password: str):
        """If you have basic authentication setup you will need to pass your pyli
        username and passwords to the requests.auth.HTTPBASICAUTH() method.

        Args:
            username (str): Username for the basic auth requests.
            password (str): Password for the basic auth requests.

        Return:
            requests.auth.HTTPBASICAUTH
        """
        self.auth = requests.auth.HTTPBasicAuth(username, password)
        return self.auth

    def request_get(self, path: str, **data) -> dict:
        """Wrapper on the session.get
        Kwargs:
            **data: Any url attributes to add to the request.

        Returns:
            requests.models.Response: Response object form requests.
        """

        headers = {"X-Api-Key": self.api_key}
        request_url = f"{self.host_url}{path}"

        try:
            response = self.session.get(
                request_url, headers=headers, auth=self.auth, params=data
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"HTTP request failed: {e}")
            return {}

    def request_post(self, path: str, data: dict) -> dict:
        """Wrapper on the requests.post
        Args:
            path (str): Path to API.
            data (dict): Data payload to send with request.
        Returns:
            dict: Response JSON data.
        """
        headers = {"X-Api-Key": self.api_key}
        request_url = f"{self.host_url}{path}"
        try:
            response = self.session.post(
                request_url, headers=headers, json=data, auth=self.auth
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"HTTP POST request failed: {e}")
            return {}

    def request_put(self, path: str, data: dict) -> dict:
        """Wrapper on the requests.put
        Args:
            path (str): Path to API.
            data (dict): Data payload to send with request.
        Returns:
            dict: Response JSON data.
        """
        headers = {"X-Api-Key": self.api_key}
        request_url = f"{self.host_url}{path}"
        try:
            response = self.session.put(
                request_url, headers=headers, json=data, auth=self.auth
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"HTTP PUT request failed: {e}")
            return {}

    def request_delete(self, path: str, data: dict) -> dict:
        """Wrapper on the requests.delete
        Args:
            path (str): Path to API.
            data (dict): Data payload to send with request.
        Returns:
            dict: Response JSON data.
        """
        headers = {"X-Api-Key": self.api_key}
        request_url = f"{self.host_url}{path}"
        try:
            response = self.session.delete(
                request_url, headers=headers, json=data, auth=self.auth
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"HTTP DELETE request failed: {e}")
            return {}
        except ValueError:
            # Catch JSON decode error in case the response has no body
            return {}
