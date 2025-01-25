const MODEL_TYPES = {
    SINGLETON: 'singleton',
    ENTITY: 'entity',
    LOG: 'log'
};

const FIELD_TYPES = {
    ID: 'id',
    STRING: 'string',
    NUMBER: 'number',
    BOOLEAN: 'boolean',
    TIMESTAMP: 'timestamp',
    JSON: 'json',
    RELATION: 'relation',
    IMAGE: 'image'
};

const MODELS_META = {
    Configuration: {
        type: MODEL_TYPES.SINGLETON,
        description: "Global configuration settings",
        readonly: false,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique identifier for configuration" },
            media_server_name: { type: FIELD_TYPES.STRING, label: "Server Name", description: "Name of the media server" },
            prefix_keyword: { type: FIELD_TYPES.STRING, label: "Command Prefix", description: "Bot command prefix" },
            discord_token: { type: FIELD_TYPES.STRING, label: "Discord Token", description: "Authentication token for Discord bot", sensitive: true },
            radarr_url: { type: FIELD_TYPES.STRING, label: "Radarr URL", description: "URL for Radarr API" },
            radarr_token: { type: FIELD_TYPES.STRING, label: "Radarr Token", description: "Authentication token for Radarr API", sensitive: true },
            sonarr_url: { type: FIELD_TYPES.STRING, label: "Sonarr URL", description: "URL for Sonarr API" },
            sonarr_token: { type: FIELD_TYPES.STRING, label: "Sonarr Token", description: "Authentication token for Sonarr API", sensitive: true },
            session_timeout: { type: FIELD_TYPES.NUMBER, label: "Session Timeout", description: "Session timeout in seconds", min: 30, max: 3600 },
            max_check_time: { type: FIELD_TYPES.NUMBER, label: "Max Check Time", description: "Maximum check time in seconds", min: 60, max: 3600 },
            max_results: { type: FIELD_TYPES.NUMBER, label: "Max Results", description: "Maximum number of results (0 for unlimited)", min: 0 },
            max_seasons_for_non_admin: { type: FIELD_TYPES.NUMBER, label: "Max Seasons", description: "Maximum seasons for non-admin users (0 for unlimited)", min: 0 },
            is_debug: { type: FIELD_TYPES.BOOLEAN, label: "Debug Mode", description: "Enable debug logging" },
            is_radarr_enabled: { type: FIELD_TYPES.BOOLEAN, label: "Radarr Enabled", description: "Enable Radarr integration" },
            is_sonarr_enabled: { type: FIELD_TYPES.BOOLEAN, label: "Sonarr Enabled", description: "Enable Sonarr integration" },
            is_trailers_enabled: { type: FIELD_TYPES.BOOLEAN, label: "Trailers Enabled", description: "Enable movie trailers" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, label: "Created At", description: "Timestamp when configuration was created", computed: true, readonly: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, label: "Updated At", description: "Timestamp when configuration was last updated", computed: true, readonly: true }
        }
    },
    State: {
        type: MODEL_TYPES.SINGLETON,
        description: "Application state",
        readonly: true,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique identifier for state" },
            discord_state: { type: FIELD_TYPES.BOOLEAN, label: "Discord State", description: "Discord connection state" },
            sidebar_exp_state: { type: FIELD_TYPES.BOOLEAN, label: "Sidebar Expanded", description: "Sidebar expansion state" },
            active_server_id: { type: FIELD_TYPES.RELATION, label: "Active Server", description: "Currently selected server identifier" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, label: "Created At", description: "Timestamp when state was created", computed: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, label: "Updated At", description: "Timestamp when state was last updated", computed: true },
            activeServer: { type: FIELD_TYPES.RELATION, label: "Active Server Reference", description: "Reference to the currently active server", hidden: true }
        }
    },
    EventLog: {
        type: MODEL_TYPES.LOG,
        description: "Event logging",
        readonly: true,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, searchable: true, label: "ID", description: "Unique identifier for event log entry" },
            timestamp: { type: FIELD_TYPES.TIMESTAMP, label: "Timestamp", description: "When the event occurred", computed: true },
            level: { type: FIELD_TYPES.STRING, label: "Log Level", description: "Severity level of the event", immutable: true },
            message: { type: FIELD_TYPES.STRING, label: "Message", description: "Event description or message", immutable: true, searchable: true },
            metadata: { type: FIELD_TYPES.JSON, label: "Metadata", description: "Additional event data in JSON format", immutable: true }
        }
    },
    DiscordBot: {
        type: MODEL_TYPES.SINGLETON,
        description: "Discord bot configuration",
        readonly: true,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique identifier for bot configuration" },
            bot_id: { type: FIELD_TYPES.STRING, label: "Bot ID", description: "Discord bot's unique identifier" },
            bot_username: { type: FIELD_TYPES.STRING, label: "Username", description: "Bot's display name" },
            bot_discriminator: { type: FIELD_TYPES.STRING, label: "Discriminator", description: "Bot's discriminator" },
            bot_avatar_url: { 
                type: FIELD_TYPES.IMAGE, 
                label: "Avatar URL", 
                description: "Bot's avatar image",
                cacheFolder: "discord_bot_images"
            },
            bot_invite_link: { type: FIELD_TYPES.STRING, label: "Invite Link", description: "Bot's invite URL" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Created At", description: "Timestamp when bot was created" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Updated At", description: "Timestamp when bot was last updated" }
        }
    },
    DiscordServer: {
        type: MODEL_TYPES.ENTITY,
        description: "Discord server information",
        readonly: true,
        fields: {
            server_id: { type: FIELD_TYPES.ID, readonly: true, searchable: true, label: "Server ID", description: "Discord server unique identifier" },
            unread_message_count: { type: FIELD_TYPES.NUMBER, label: "Unread Count", description: "Number of unread messages" },
            server_name: { type: FIELD_TYPES.STRING, label: "Server Name", description: "Discord server name", searchable: true },
            server_avatar_url: { 
                type: FIELD_TYPES.IMAGE, 
                label: "Avatar URL", 
                description: "Server icon image",
                cacheFolder: 'discord_server_images'
            },
            sort_position: { type: FIELD_TYPES.NUMBER, label: "Sort Position", description: "Server's position in the list" },
            active_channel_id: { type: FIELD_TYPES.STRING, label: "Active Channel", description: "Currently selected channel identifier" },
            available: { type: FIELD_TYPES.BOOLEAN, label: "Available", description: "Server availability status" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Created At", description: "Timestamp when server was added" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Updated At", description: "Timestamp when server was last updated" },
            users: { type: FIELD_TYPES.RELATION, hidden: true, label: "Users", description: "Related server users" },
            requests: { type: FIELD_TYPES.RELATION, hidden: true, label: "Requests", description: "Related server requests" },
            channels: { type: FIELD_TYPES.RELATION, hidden: true, label: "Channels", description: "Related server channels" },
            messages: { type: FIELD_TYPES.RELATION, hidden: true, label: "Messages", description: "Related server messages" },
            state: { type: FIELD_TYPES.RELATION, hidden: true, label: "State", description: "Server state reference" }
        }
    },
    DiscordServerChannel: {
        type: MODEL_TYPES.ENTITY,
        description: "Discord channel information",
        readonly: true,
        fields: {
            channel_id: { type: FIELD_TYPES.ID, readonly: true, searchable: true, label: "Channel ID", description: "Discord channel unique identifier" },
            channel_name: { type: FIELD_TYPES.STRING, label: "Channel Name", description: "Discord channel name", searchable: true },
            position: { type: FIELD_TYPES.NUMBER, label: "Position", description: "Channel position in list", readonly: true },
            discord_server: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true, label: "Server", description: "Parent server reference" },
            channel_type: { type: FIELD_TYPES.NUMBER, label: "Channel Type", description: "0: Text, 2: Voice, 4: Category" },
            isTextChannel: { type: FIELD_TYPES.BOOLEAN, computed: true, readonly: true, label: "Is Text Channel", description: "Channel is text type" },
            isVoiceChannel: { type: FIELD_TYPES.BOOLEAN, computed: true, readonly: true, label: "Is Voice Channel", description: "Channel is voice type" },
            isCategory: { type: FIELD_TYPES.BOOLEAN, computed: true, readonly: true, label: "Is Category", description: "Channel is category type" },
            parent_id: { type: FIELD_TYPES.STRING, readonly: true, label: "Parent ID", description: "Parent category identifier" },
            unread_message_count: { type: FIELD_TYPES.NUMBER, label: "Unread Count", description: "Number of unread messages" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Timestamp when channel was created" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Timestamp when channel was last updated" },
            server: { type: FIELD_TYPES.RELATION, hidden: true, label: "Server", description: "Related server reference" },
            messages: { type: FIELD_TYPES.RELATION, hidden: true, label: "Messages", description: "Related channel messages" }
        }
    },
    DiscordMessage: {
        type: MODEL_TYPES.ENTITY,
        description: "Discord message data",
        readonly: true,
        fields: {
            message_id: { type: FIELD_TYPES.ID, readonly: true, searchable: true, label: "Message ID", description: "Unique message identifier" },
            server_id: { type: FIELD_TYPES.RELATION, immutable: true, label: "Server ID", description: "Associated server reference" },
            channel_id: { type: FIELD_TYPES.RELATION, immutable: true, label: "Channel ID", description: "Associated channel reference" },
            user_id: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true, label: "User ID", description: "Message author reference" },
            content: { type: FIELD_TYPES.STRING, label: "Content", description: "Message content", searchable: true },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Created At", description: "Message creation timestamp" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Updated At", description: "Message update timestamp" },
            server: { type: FIELD_TYPES.RELATION, hidden: true, label: "Server", description: "Server relation reference" },
            channel: { type: FIELD_TYPES.RELATION, hidden: true, label: "Channel", description: "Channel relation reference" },
            user: { type: FIELD_TYPES.RELATION, hidden: true, label: "User", description: "User relation reference" }
        }
    },
    Media: {
        type: MODEL_TYPES.ENTITY,
        description: "Media information",
        readonly: false,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique media identifier" },
            title: { type: FIELD_TYPES.STRING, label: "Title", description: "Media title", searchable: true },
            overview: { type: FIELD_TYPES.STRING, label: "Overview", description: "Media description" },
            poster_url: { 
                label: "Poster URL",
                description: "Media poster image",
                type: FIELD_TYPES.IMAGE,
                cacheFolder: 'media_images'
            },
            year: { type: FIELD_TYPES.NUMBER, label: "Year", description: "Release year" },
            path: { type: FIELD_TYPES.STRING, label: "Path", description: "File system path" },
            monitored: { type: FIELD_TYPES.BOOLEAN, label: "Monitored", description: "Media monitoring status" },
            runtime: { type: FIELD_TYPES.NUMBER, label: "Runtime", description: "Duration in minutes" },
            added: { type: FIELD_TYPES.STRING, label: "Added Date", description: "When media was added to library" },
            season_count: { type: FIELD_TYPES.NUMBER, label: "Seasons", description: "Number of seasons" },
            network: { type: FIELD_TYPES.STRING, label: "Network", description: "Broadcasting network" },
            air_time: { type: FIELD_TYPES.STRING, label: "Air Time", description: "Scheduled broadcast time" },
            tvdb_id: { type: FIELD_TYPES.STRING, label: "TVDB ID", description: "TVDB identifier" },
            imdb_id: { type: FIELD_TYPES.STRING, label: "IMDB ID", description: "IMDB identifier" },
            first_aired: { type: FIELD_TYPES.STRING, label: "First Aired", description: "Original air date" },
            series_type: { type: FIELD_TYPES.STRING, label: "Series Type", description: "Type of series classification" },
            in_theaters: { type: FIELD_TYPES.STRING, label: "In Theaters", description: "Theatrical release date" },
            website_url: { type: FIELD_TYPES.STRING, label: "Website", description: "Official website URL" },
            trailer_url: { type: FIELD_TYPES.STRING, label: "Trailer URL", description: "Media trailer link" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Record creation timestamp" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Record update timestamp" },
            requests: { type: FIELD_TYPES.RELATION, hidden: true, readonly: true, label: "Requests", description: "Related media requests" }
        }
    },
    MediaRequest: {
        type: MODEL_TYPES.ENTITY,
        description: "Media request tracking",
        readonly: false,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, searchable: true, label: "ID", description: "Unique request identifier" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Request creation timestamp" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Request update timestamp" },
            made_in: { type: FIELD_TYPES.RELATION, hidden: true, label: "Made In", description: "Request origin reference" },
            madeInId: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true, label: "Made In ID", description: "Origin identifier reference" },
            media: { type: FIELD_TYPES.RELATION, hidden: true, label: "Media", description: "Requested media reference" },
            mediaId: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true, label: "Media ID", description: "Media identifier reference" },
            orig_message: { type: FIELD_TYPES.STRING, label: "Original Message", description: "Initial request message", searchable: true },
            orig_parsed_title: { type: FIELD_TYPES.STRING, label: "Parsed Title", description: "Extracted media title" },
            orig_parsed_type: { type: FIELD_TYPES.STRING, label: "Parsed Type", description: "Detected media type" },
            status: { type: FIELD_TYPES.BOOLEAN, label: "Status", description: "Request status", readonly: true },
            users: { type: FIELD_TYPES.RELATION, hidden: true, label: "Users", description: "Related user references" }
        }
    },
    User: {
        type: MODEL_TYPES.ENTITY,
        description: "User information",
        readonly: false,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, searchable: true, label: "ID", description: "Unique user identifier" },
            username: { type: FIELD_TYPES.STRING, label: "Username", description: "Discord username", searchable: true },
            display_name: { type: FIELD_TYPES.STRING, label: "Display Name", description: "User's display name", searchable: true },
            accent_color: { type: FIELD_TYPES.STRING, label: "Accent Color", description: "UI theme color" },
            avatar_url: {
                label: "Avatar URL",
                description: "User's avatar image",
                type: FIELD_TYPES.IMAGE,
                cacheFolder: 'user_images'
            },
            is_superuser: { type: FIELD_TYPES.BOOLEAN, label: "Superuser", description: "Administrator privileges" },
            is_staff: { type: FIELD_TYPES.BOOLEAN, label: "Staff", description: "Staff privileges" },
            is_active: { type: FIELD_TYPES.BOOLEAN, label: "Active", description: "Account status" },
            is_bot: { type: FIELD_TYPES.BOOLEAN, label: "Bot", description: "Bot account indicator" },
            is_client: { type: FIELD_TYPES.BOOLEAN, label: "Client", description: "Client user indicator" },
            session_timeout: { type: FIELD_TYPES.NUMBER, label: "Session Timeout", description: "User session timeout", min: 30, max: 3600 },
            max_check_time: { type: FIELD_TYPES.NUMBER, label: "Max Check Time", description: "Maximum check time", min: 60, max: 3600 },
            max_results: { type: FIELD_TYPES.NUMBER, label: "Max Results", description: "Maximum search results", min: 0 },
            max_seasons_for_non_admin: { type: FIELD_TYPES.NUMBER, label: "Max Seasons", description: "Maximum seasons allowed", min: 0 },
            max_requests_in_day: { type: FIELD_TYPES.NUMBER, label: "Daily Request Limit", description: "Maximum requests per day", min: 0 },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Account creation timestamp" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Account update timestamp" },
            discord_servers: { type: FIELD_TYPES.RELATION, hidden: true, label: "Discord Servers", description: "Associated server references" },
            requests: { type: FIELD_TYPES.RELATION, hidden: true, label: "Requests", description: "User's media requests" },
            messages: { type: FIELD_TYPES.RELATION, hidden: true, label: "Messages", description: "User's messages" }
        }
    }
};

module.exports = {
    MODEL_TYPES,
    FIELD_TYPES,
    MODELS_META
};
