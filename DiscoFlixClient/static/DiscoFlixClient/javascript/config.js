export const FIELD_SORT = {
    'media-server-configuration': [
        'media_server_name',
        'is_radarr_enabled',
        'is_sonarr_enabled',
        'radarr_url',
        'radarr_token',
        'sonarr_url',
        'sonarr_token',
        'is_tagging_enabled',
        'tag_label',
        'is_request_existing_enabled'
    ],
    'discord-bot-configuration': [
        'prefix_keyword',
        'discord_token'
    ],
    'ai-configuration': [
        'is_openai_enabled',
        'openai_token',
        'openai_model_name',
        'is_mention_enabled'
    ],
    'auth-configuration': [
        'is_login_required'
    ],
    'debug-configuration': [
        'is_verbose_logging',
        'is_debug'
    ],
    'misc-configuration': [
        'session_timeout',
        'max_check_time',
        'max_results',
        'max_seasons_for_non_admin',
        'is_trailers_enabled'
    ]
};

export const ADDITIONAL_USER_SETTINGS = {
    'session_timeout': {
        VERBOSE: 'Session Timeout',
        TYPE: 'INT',
        DEFAULT: 60
    },
    'max_check_time': {
        VERBOSE: 'Monitoring Timeout (Seconds)',
        TYPE: 'INT',
        DEFAULT: 600
    },
    'max_results': {
        VERBOSE: 'Max Search Results',
        TYPE: 'INT',
        DEFAULT: 0
    },
    'max_seasons_for_non_admin': {
        VERBOSE: 'Max Seasons Per Request',
        TYPE: 'INT',
        DEFAULT: 0
    },
    'max_requests_in_day': {
        VERBOSE: 'Max Requests Per 24H',
        TYPE: 'INT',
        DEFAULT: 0
    },
    'is_superuser': {
        VERBOSE: 'Server Owner / Super User',
        TYPE: 'BOOL',
        DEFAULT: false
    },
    'is_staff': {
        VERBOSE: 'Grant Database Access',
        TYPE: 'BOOL',
        DEFAULT: false
    },
    'password': {
        VERBOSE: 'User Auth Password',
        TYPE: 'PASSWORD',
        DEFAULT: ''
    },
    'can_request_existing': {
        VERBOSE: 'Allow Requests For Monitored Content',
        TYPE: 'BOOL',
        DEFAULT: false
    }
};
