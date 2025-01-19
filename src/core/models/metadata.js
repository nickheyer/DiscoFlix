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
    RELATION: 'relation'
};

const MODELS_META = {
    Configuration: {
        type: MODEL_TYPES.SINGLETON,
        description: "Global configuration settings",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, hidden: true },
            media_server_name: { type: FIELD_TYPES.STRING, label: "Server Name", description: "Name of the media server" },
            prefix_keyword: { type: FIELD_TYPES.STRING, label: "Command Prefix", description: "Bot command prefix" },
            discord_token: { type: FIELD_TYPES.STRING, label: "Discord Token", sensitive: true, hidden: true },
            radarr_url: { type: FIELD_TYPES.STRING, label: "Radarr URL", description: "URL for Radarr API" },
            radarr_token: { type: FIELD_TYPES.STRING, label: "Radarr Token", sensitive: true, hidden: true },
            sonarr_url: { type: FIELD_TYPES.STRING, label: "Sonarr URL", description: "URL for Sonarr API" },
            sonarr_token: { type: FIELD_TYPES.STRING, label: "Sonarr Token", sensitive: true, hidden: true },
            session_timeout: { type: FIELD_TYPES.NUMBER, label: "Session Timeout", description: "Session timeout in seconds", min: 30, max: 3600 },
            max_check_time: { type: FIELD_TYPES.NUMBER, label: "Max Check Time", description: "Maximum check time in seconds", min: 60, max: 3600 },
            max_results: { type: FIELD_TYPES.NUMBER, label: "Max Results", description: "Maximum number of results (0 for unlimited)", min: 0 },
            max_seasons_for_non_admin: { type: FIELD_TYPES.NUMBER, label: "Max Seasons", description: "Maximum seasons for non-admin users (0 for unlimited)", min: 0 },
            is_debug: { type: FIELD_TYPES.BOOLEAN, label: "Debug Mode", description: "Enable debug logging" },
            is_radarr_enabled: { type: FIELD_TYPES.BOOLEAN, label: "Radarr Enabled", description: "Enable Radarr integration" },
            is_sonarr_enabled: { type: FIELD_TYPES.BOOLEAN, label: "Sonarr Enabled", description: "Enable Sonarr integration" },
            is_trailers_enabled: { type: FIELD_TYPES.BOOLEAN, label: "Trailers Enabled", description: "Enable movie trailers" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true }
        }
    },
    State: {
        type: MODEL_TYPES.SINGLETON,
        description: "Application state",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, hidden: true },
            discord_state: { type: FIELD_TYPES.BOOLEAN, label: "Discord State", description: "Discord connection state" },
            sidebar_exp_state: { type: FIELD_TYPES.BOOLEAN, label: "Sidebar Expanded", description: "Sidebar expansion state" },
            active_server_id: { type: FIELD_TYPES.RELATION, hidden: true },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            activeServer: { type: FIELD_TYPES.RELATION, hidden: true }
        }
    },
    EventLog: {
        type: MODEL_TYPES.LOG,
        description: "Event logging",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true },
            timestamp: { type: FIELD_TYPES.TIMESTAMP, computed: true },
            level: { type: FIELD_TYPES.STRING, immutable: true },
            message: { type: FIELD_TYPES.STRING, immutable: true },
            metadata: { type: FIELD_TYPES.JSON, immutable: true }
        }
    },
    DiscordBot: {
        type: MODEL_TYPES.SINGLETON,
        description: "Discord bot configuration",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, hidden: true },
            bot_id: { type: FIELD_TYPES.STRING, label: "Bot ID", hidden: true },
            bot_username: { type: FIELD_TYPES.STRING, label: "Username", description: "Bot's display name" },
            bot_discriminator: { type: FIELD_TYPES.STRING, label: "Discriminator", description: "Bot's discriminator" },
            bot_avatar_url: { type: FIELD_TYPES.STRING, label: "Avatar URL", description: "Bot's avatar image" },
            bot_invite_link: { type: FIELD_TYPES.STRING, label: "Invite Link", description: "Bot's invite URL" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true }
        }
    },
    DiscordServer: {
        type: MODEL_TYPES.ENTITY,
        description: "Discord server information",
        fields: {
            server_id: { type: FIELD_TYPES.ID, hidden: true },
            unread_message_count: { type: FIELD_TYPES.NUMBER, label: "Unread Count" },
            server_name: { type: FIELD_TYPES.STRING, label: "Server Name", description: "Discord server name" },
            server_avatar_url: { type: FIELD_TYPES.STRING, label: "Avatar URL", description: "Server icon image" },
            sort_position: { type: FIELD_TYPES.NUMBER, label: "Sort Position", hidden: true },
            active_channel_id: { type: FIELD_TYPES.STRING, label: "Active Channel", hidden: true },
            available: { type: FIELD_TYPES.BOOLEAN, label: "Available", description: "Server availability status" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            users: { type: FIELD_TYPES.RELATION, hidden: true },
            requests: { type: FIELD_TYPES.RELATION, hidden: true },
            channels: { type: FIELD_TYPES.RELATION, hidden: true },
            messages: { type: FIELD_TYPES.RELATION, hidden: true },
            state: { type: FIELD_TYPES.RELATION, hidden: true }
        }
    },
    DiscordServerChannel: {
        type: MODEL_TYPES.ENTITY,
        description: "Discord channel information",
        fields: {
            channel_id: { type: FIELD_TYPES.ID, hidden: true },
            channel_name: { type: FIELD_TYPES.STRING, label: "Channel Name", description: "Discord channel name" },
            position: { type: FIELD_TYPES.NUMBER, label: "Position", hidden: true },
            discord_server: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true },
            channel_type: { type: FIELD_TYPES.NUMBER, label: "Channel Type", description: "0: Text, 2: Voice, 4: Category" },
            isTextChannel: { type: FIELD_TYPES.BOOLEAN, computed: true, hidden: true },
            isVoiceChannel: { type: FIELD_TYPES.BOOLEAN, computed: true, hidden: true },
            isCategory: { type: FIELD_TYPES.BOOLEAN, computed: true, hidden: true },
            parent_id: { type: FIELD_TYPES.STRING, hidden: true },
            unread_message_count: { type: FIELD_TYPES.NUMBER },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            server: { type: FIELD_TYPES.RELATION, hidden: true },
            messages: { type: FIELD_TYPES.RELATION, hidden: true }
        }
    },
    DiscordMessage: {
        type: MODEL_TYPES.ENTITY,
        description: "Discord message data",
        fields: {
            message_id: { type: FIELD_TYPES.ID },
            server_id: { type: FIELD_TYPES.RELATION, immutable: true },
            channel_id: { type: FIELD_TYPES.RELATION, immutable: true },
            user_id: { type: FIELD_TYPES.RELATION, immutable: true },
            content: { type: FIELD_TYPES.STRING, label: "Content", description: "Message content" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            server: { type: FIELD_TYPES.RELATION, hidden: true },
            channel: { type: FIELD_TYPES.RELATION, hidden: true },
            user: { type: FIELD_TYPES.RELATION, hidden: true }
        }
    },
    Media: {
        type: MODEL_TYPES.ENTITY,
        description: "Media information",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, hidden: true },
            title: { type: FIELD_TYPES.STRING, label: "Title", description: "Media title" },
            overview: { type: FIELD_TYPES.STRING, label: "Overview", description: "Media description" },
            poster_url: { type: FIELD_TYPES.STRING, label: "Poster URL", description: "Media poster image" },
            year: { type: FIELD_TYPES.NUMBER, label: "Year", description: "Release year" },
            path: { type: FIELD_TYPES.STRING, label: "Path", description: "File system path" },
            monitored: { type: FIELD_TYPES.BOOLEAN, label: "Monitored", description: "Media monitoring status" },
            runtime: { type: FIELD_TYPES.NUMBER, label: "Runtime", description: "Duration in minutes" },
            added: { type: FIELD_TYPES.STRING, label: "Added Date" },
            season_count: { type: FIELD_TYPES.NUMBER, label: "Seasons", description: "Number of seasons" },
            network: { type: FIELD_TYPES.STRING, label: "Network", description: "Broadcasting network" },
            air_time: { type: FIELD_TYPES.STRING, label: "Air Time" },
            tvdb_id: { type: FIELD_TYPES.STRING, label: "TVDB ID", description: "TVDB identifier" },
            imdb_id: { type: FIELD_TYPES.STRING, label: "IMDB ID", description: "IMDB identifier" },
            first_aired: { type: FIELD_TYPES.STRING, label: "First Aired" },
            series_type: { type: FIELD_TYPES.STRING, label: "Series Type" },
            in_theaters: { type: FIELD_TYPES.STRING, label: "In Theaters" },
            website_url: { type: FIELD_TYPES.STRING, label: "Website" },
            trailer_url: { type: FIELD_TYPES.STRING, label: "Trailer URL" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            requests: { type: FIELD_TYPES.RELATION, hidden: true }
        }
    },
    MediaRequest: {
        type: MODEL_TYPES.ENTITY,
        description: "Media request tracking",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, hidden: true },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            made_in: { type: FIELD_TYPES.RELATION, hidden: true },
            madeInId: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true },
            media: { type: FIELD_TYPES.RELATION, hidden: true },
            mediaId: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true },
            orig_message: { type: FIELD_TYPES.STRING, label: "Original Message" },
            orig_parsed_title: { type: FIELD_TYPES.STRING, label: "Parsed Title" },
            orig_parsed_type: { type: FIELD_TYPES.STRING, label: "Parsed Type" },
            status: { type: FIELD_TYPES.BOOLEAN, label: "Status", description: "Request status" },
            users: { type: FIELD_TYPES.RELATION, hidden: true }
        }
    },
    User: {
        type: MODEL_TYPES.ENTITY,
        description: "User information",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, hidden: true },
            username: { type: FIELD_TYPES.STRING, label: "Username", description: "Discord username" },
            display_name: { type: FIELD_TYPES.STRING, label: "Display Name", description: "User's display name" },
            accent_color: { type: FIELD_TYPES.STRING, label: "Accent Color", description: "UI theme color" },
            avatar_url: { type: FIELD_TYPES.STRING, label: "Avatar URL", description: "User's avatar image" },
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
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, hidden: true },
            discord_servers: { type: FIELD_TYPES.RELATION, hidden: true },
            requests: { type: FIELD_TYPES.RELATION, hidden: true },
            messages: { type: FIELD_TYPES.RELATION, hidden: true }
        }
    }
};

module.exports = {
    MODEL_TYPES,
    FIELD_TYPES,
    MODELS_META
};