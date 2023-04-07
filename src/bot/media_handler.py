from models.models import Media, MediaRequest


METADATA_MAP = {
    'title': 'title',
    'overview' : 'overview',
    'remotePoster' : 'poster_url',
    'year' : 'year',
    'path' : 'path',
    'monitored' : 'monitored', 
    'runtime' : 'runtime', 
    'added' : 'added',
    'seasonCount' : 'season_count',
    'network' : 'network',
    'airTime' : 'air_time',
    'tvdbId' : 'tvdb_id',
    'imdbId' : 'imdb_id',
    'firstAired' : 'first_aired',
    'seriesType' : 'series_type',
    'inCinemas':'in_theaters',
    'website': 'website_url',
    'youTubeTrailerId': 'trailer_url'
}


def create_media(metadata):
    media = Media()
    for field, value in metadata.items():
        if field in METADATA_MAP.keys():
            field_name = METADATA_MAP[field]
            setattr(media, field_name, value)
    media.save()
    return media

def create_media_request(
    user_object,
    media_object,
    discord_server,
    message_str,
    parsed_title,
    content_type
    ):
    request = MediaRequest(
        made_in=discord_server,
        media=media_object,
        orig_message=message_str,
        orig_parsed_title=parsed_title,
        orig_parsed_type=content_type
    )
    request.save()
    user_object.requests.add(request)
    return request