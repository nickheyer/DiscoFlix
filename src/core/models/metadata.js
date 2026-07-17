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
            admin_password: { type: FIELD_TYPES.STRING, label: "Admin Password", description: "Setting this locks the web console behind a login (blank = open)", sensitive: true },
            discord_token: { type: FIELD_TYPES.STRING, label: "Discord Token", description: "Authentication token for Discord bot", sensitive: true },
            is_debug: { type: FIELD_TYPES.BOOLEAN, label: "Debug Mode", description: "Enable debug logging" },
            // THE FIELDS BELOW LIVE ON THE DISCORD BOT TAB, NOT dfSettings -
            // computed KEEPS THE dfSettings FULL-FORM SAVE (_sanitizeData) FROM
            // WIPING THEM; THE BOT TAB WRITES THEM VIA PARTIAL update() ONLY
            prefix_keyword: { type: FIELD_TYPES.STRING, computed: true, label: "Command Prefix", description: "The keyword that wakes the bot in chat" },
            bot_presence_activity: {
                type: FIELD_TYPES.STRING, computed: true, label: "Presence Activity", description: "The verb on the bot's status line",
                options: [
                    { value: "none", label: "None" },
                    { value: "playing", label: "Playing" },
                    { value: "watching", label: "Watching" },
                    { value: "listening", label: "Listening to" },
                    { value: "competing", label: "Competing in" }
                ]
            },
            bot_presence_text: { type: FIELD_TYPES.STRING, computed: true, label: "Presence Text", description: "What the status line says the bot is doing" },
            whitelist_role_ids: { type: FIELD_TYPES.STRING, computed: true, size: "full", label: "Whitelist Roles", description: "Comma-separated role names or ids that grant the whitelisted tier - grants only, revoke in Users" },
            staff_role_ids: { type: FIELD_TYPES.STRING, computed: true, size: "full", label: "Staff Roles", description: "Comma-separated role names or ids that grant staff - grants only, revoke in Users" },
            admin_role_ids: { type: FIELD_TYPES.STRING, computed: true, size: "full", label: "Admin Roles", description: "Comma-separated role names or ids that grant admin - grants only, revoke in Users" },
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
            created_at: { type: FIELD_TYPES.TIMESTAMP, label: "Created At", description: "Timestamp when state was created", computed: true },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, label: "Updated At", description: "Timestamp when state was last updated", computed: true }
        }
    },
    ViewSession: {
        type: MODEL_TYPES.ENTITY,
        description: "Per-browser view sessions",
        readonly: true,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "View session identifier (df_view cookie)" },
            sidebar_exp_state: { type: FIELD_TYPES.BOOLEAN, label: "Sidebar Expanded", description: "This browser's sidebar expansion state" },
            active_server_id: { type: FIELD_TYPES.RELATION, label: "Active Server", description: "Server this browser is viewing" },
            active_app_id: { type: FIELD_TYPES.RELATION, label: "Active App", description: "App takeover this browser is inside (null = Discord mirror)" },
            active_channels: { type: FIELD_TYPES.JSON, hidden: true, label: "Channel Picks", description: "JSON map of per-server channel picks" },
            last_seen_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Last Seen", description: "Last request from this browser" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Created At", description: "Timestamp when this session was created" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, label: "Updated At", description: "Timestamp when this session was last updated" },
            activeServer: { type: FIELD_TYPES.RELATION, hidden: true, label: "Active Server Reference", description: "Reference to the viewed server" },
            activeApp: { type: FIELD_TYPES.RELATION, hidden: true, label: "Active App Reference", description: "Reference to the active app instance" }
        }
    },
    App: {
        type: MODEL_TYPES.ENTITY,
        description: "Installed app instances (Radarr, Sonarr, SABnzbd, qBittorrent...)",
        readonly: false,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique identifier for this app instance" },
            // app_type/is_default/sort_position/active_section ARE computed SO
            // _sanitizeData NEVER RESETS THEM ON FORM SAVES - THEY ARE MANAGED
            // BY DEDICATED ENDPOINTS VIA PARTIAL update()
            app_type: { type: FIELD_TYPES.STRING, computed: true, readonly: true, label: "App Type", description: "Registry key: radarr, sonarr, sabnzbd, qbittorrent" },
            display_name: { type: FIELD_TYPES.STRING, required: true, searchable: true, label: "Display Name", description: "Shown on the app's rail bubble and banner" },
            enabled: { type: FIELD_TYPES.BOOLEAN, label: "Enabled", description: "Disabled apps keep their config but stop serving requests" },
            url: { type: FIELD_TYPES.STRING, size: "full", label: "URL", description: "Base URL of the service" },
            api_key: { type: FIELD_TYPES.STRING, sensitive: true, label: "API Key", description: "Service API key" },
            username: { type: FIELD_TYPES.STRING, label: "Username", description: "Service login username" },
            password: { type: FIELD_TYPES.STRING, sensitive: true, label: "Password", description: "Service login password" },
            // computed KEEPS FORM SAVES OFF IT - WRITTEN VIA PARTIAL update() ONLY
            settings_json: { type: FIELD_TYPES.JSON, hidden: true, computed: true, label: "Settings", description: "Per-type extra settings" },
            is_default: { type: FIELD_TYPES.BOOLEAN, computed: true, readonly: true, label: "Default", description: "Wins content-type routing among peer instances" },
            sort_position: { type: FIELD_TYPES.NUMBER, computed: true, readonly: true, label: "Sort Position", description: "Rail order" },
            active_section: { type: FIELD_TYPES.STRING, computed: true, readonly: true, label: "Active Section", description: "Last viewed section of this app's console surface" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Timestamp when this app was added" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Timestamp when this app was last updated" },
            requests: { type: FIELD_TYPES.RELATION, hidden: true, label: "Requests", description: "Requests routed to this instance" },
            state: { type: FIELD_TYPES.RELATION, hidden: true, label: "State", description: "Takeover state reference" }
        }
    },
    AiConversation: {
        type: MODEL_TYPES.ENTITY,
        description: "AI provider conversation thread",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique identifier for this conversation" },
            appId: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true, label: "App", description: "Owning AI provider instance" },
            surface: { type: FIELD_TYPES.STRING, computed: true, readonly: true, label: "Surface", description: "Where this thread lives: console or discord" },
            context_key: { type: FIELD_TYPES.STRING, computed: true, readonly: true, label: "Context Key", description: "Discord channel id for channel threads (null = console thread)" },
            title: { type: FIELD_TYPES.STRING, searchable: true, label: "Title", description: "Thread title, taken from the first message" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Timestamp when this thread started" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Timestamp of the latest turn" },
            app: { type: FIELD_TYPES.RELATION, hidden: true, label: "App Reference", description: "Reference to the owning app instance" },
            messages: { type: FIELD_TYPES.RELATION, hidden: true, label: "Messages", description: "Turns in this conversation" }
        }
    },
    AiMessage: {
        type: MODEL_TYPES.ENTITY,
        description: "One turn in an AI conversation",
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique identifier for this turn" },
            conversationId: { type: FIELD_TYPES.RELATION, immutable: true, hidden: true, label: "Conversation", description: "Owning conversation thread" },
            role: { type: FIELD_TYPES.STRING, computed: true, readonly: true, label: "Role", description: "user or assistant" },
            content: { type: FIELD_TYPES.STRING, searchable: true, label: "Content", description: "Renderable message text" },
            blocks_json: { type: FIELD_TYPES.JSON, hidden: true, computed: true, label: "Blocks", description: "Provider-neutral content blocks (tool trace included)" },
            author_label: { type: FIELD_TYPES.STRING, computed: true, readonly: true, label: "Author", description: "Display attribution for the turn" },
            author_key: { type: FIELD_TYPES.STRING, computed: true, readonly: true, hidden: true, label: "Author Key", description: "Discord user id or 'console' - drives per-user caps" },
            usage_json: { type: FIELD_TYPES.JSON, hidden: true, computed: true, label: "Usage", description: "Token usage for assistant turns" },
            error: { type: FIELD_TYPES.STRING, computed: true, readonly: true, label: "Error", description: "Provider failure note for this turn" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Timestamp of this turn" },
            conversation: { type: FIELD_TYPES.RELATION, hidden: true, label: "Conversation Reference", description: "Reference to the owning thread" }
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
                label: "Server Avatar URL", 
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
        alias: 'discordChannel',
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
            embeds: { type: FIELD_TYPES.JSON, hidden: true, label: "Embeds", description: "Serialized Discord embeds" },
            attachments: { type: FIELD_TYPES.JSON, hidden: true, label: "Attachments", description: "Serialized Discord attachments" },
            previous_content: { type: FIELD_TYPES.STRING, hidden: true, label: "Previous Content", description: "Content before the latest edit" },
            edited_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Edited At", description: "When the message content was last edited" },
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
            tmdb_id: { type: FIELD_TYPES.STRING, label: "TMDB ID", description: "TMDB identifier" },
            imdb_id: { type: FIELD_TYPES.STRING, label: "IMDB ID", description: "IMDB identifier" },
            musicbrainz_id: { type: FIELD_TYPES.STRING, label: "MusicBrainz ID", description: "MusicBrainz release group identifier" },
            first_aired: { type: FIELD_TYPES.STRING, label: "First Aired", description: "Original air date" },
            series_type: { type: FIELD_TYPES.STRING, label: "Series Type", description: "Type of series classification" },
            in_theaters: { type: FIELD_TYPES.STRING, label: "In Theaters", description: "Theatrical release date" },
            website_url: { type: FIELD_TYPES.STRING, label: "Website", description: "Official website URL" },
            trailer_url: { type: FIELD_TYPES.STRING, label: "Trailer URL", description: "Media trailer link" },
            is_available: { type: FIELD_TYPES.BOOLEAN, label: "Available", description: "Downloaded and available on the media server" },
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
            orig_channel_id: { type: FIELD_TYPES.STRING, hidden: true, label: "Origin Channel", description: "Discord channel the request came from" },
            orig_message_id: { type: FIELD_TYPES.STRING, hidden: true, label: "Origin Message", description: "Discord message that triggered the request" },
            arr_id: { type: FIELD_TYPES.STRING, hidden: true, readonly: true, label: "Service Item ID", description: "The connected service's id for the added item" },
            seasons: { type: FIELD_TYPES.STRING, hidden: true, readonly: true, label: "Seasons", description: "Picked season numbers as JSON, null = all" },
            status: { type: FIELD_TYPES.BOOLEAN, label: "Status", description: "Request status", readonly: true },
            users: { type: FIELD_TYPES.RELATION, hidden: true, label: "Users", description: "Related user references" }
        }
    },
    User: {
        type: MODEL_TYPES.ENTITY,
        description: "User information",
        readonly: false,
        // IDENTITY FIELDS ARE DISCORD-SYNCED: readonly KEEPS FORM SAVES OFF
        // THEM (_sanitizeData SKIPS readonly) - THE SYNC WRITES VIA update()
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, searchable: true, label: "ID", description: "Unique user identifier" },
            username: { type: FIELD_TYPES.STRING, readonly: true, label: "Username", description: "Discord username", searchable: true },
            display_name: { type: FIELD_TYPES.STRING, readonly: true, label: "Display Name", description: "User's display name", searchable: true },
            accent_color: { type: FIELD_TYPES.STRING, readonly: true, label: "Accent Color", description: "UI theme color" },
            avatar_url: {
                label: "Avatar URL",
                description: "User's avatar image",
                type: FIELD_TYPES.IMAGE,
                readonly: true,
                cacheFolder: 'user_images'
            },
            is_superuser: { type: FIELD_TYPES.BOOLEAN, label: "Superuser", description: "Administrator privileges" },
            is_staff: { type: FIELD_TYPES.BOOLEAN, label: "Staff", description: "Staff privileges" },
            is_active: { type: FIELD_TYPES.BOOLEAN, label: "Active", description: "Account status" },
            is_whitelisted: { type: FIELD_TYPES.BOOLEAN, label: "Whitelisted", description: "May request when access is whitelist-only" },
            is_bot: { type: FIELD_TYPES.BOOLEAN, readonly: true, label: "Bot", description: "Bot account indicator" },
            is_client: { type: FIELD_TYPES.BOOLEAN, readonly: true, label: "Client", description: "Client user indicator" },
            access_requested_at: { type: FIELD_TYPES.TIMESTAMP, readonly: true, label: "Access Requested", description: "When the user asked to request while whitelist-gated" },
            last_seen_at: { type: FIELD_TYPES.TIMESTAMP, readonly: true, label: "Last Seen", description: "Most recent message, interaction, or roster sighting" },
            // PER-USER EXCEPTIONS - >0 BEATS THE FEATURE RULE'S EXTENT
            max_results: { type: FIELD_TYPES.NUMBER, label: "Max Results", description: "Maximum search results (0 = follow the feature rule)", min: 0 },
            max_seasons_for_non_admin: { type: FIELD_TYPES.NUMBER, label: "Max Seasons", description: "Maximum seasons allowed (0 = follow the feature rule)", min: 0 },
            max_requests_in_day: { type: FIELD_TYPES.NUMBER, label: "Daily Request Limit", description: "Maximum requests per day (0 = follow the feature rule)", min: 0 },
            notes: { type: FIELD_TYPES.STRING, size: 'full', multiline: true, label: "Notes", description: "Operator notes - only visible in this console" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Account creation timestamp" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Account update timestamp" },
            discord_servers: { type: FIELD_TYPES.RELATION, hidden: true, label: "Discord Servers", description: "Associated server references" },
            requests: { type: FIELD_TYPES.RELATION, hidden: true, label: "Requests", description: "User's media requests" },
            messages: { type: FIELD_TYPES.RELATION, hidden: true, label: "Messages", description: "User's messages" }
        }
    },
    BotFeatureRule: {
        type: MODEL_TYPES.ENTITY,
        description: "Per-feature bot grants - the Discord Bot tab's feature matrix",
        readonly: false,
        fields: {
            id: { type: FIELD_TYPES.ID, immutable: true, readonly: true, label: "ID", description: "Unique identifier for this rule" },
            feature_id: { type: FIELD_TYPES.STRING, computed: true, label: "Feature", description: "Stable feature id from the interaction registry (request.movie, status, ...)" },
            server_id: { type: FIELD_TYPES.RELATION, computed: true, label: "Server", description: "NULL = the global rule; set = a per-server override that wins outright" },
            enabled: { type: FIELD_TYPES.BOOLEAN, label: "Enabled", description: "Disabled features deny everyone at dispatch" },
            audience: {
                type: FIELD_TYPES.STRING, label: "Audience", description: "Minimum tier that may use this feature",
                options: [
                    { value: "everyone", label: "Everyone" },
                    { value: "whitelisted", label: "Whitelisted" },
                    { value: "staff", label: "Staff" },
                    { value: "admin", label: "Admins" }
                ]
            },
            role_ids: { type: FIELD_TYPES.STRING, size: "full", label: "Extra Roles", description: "Comma-separated role names or ids that qualify regardless of tier" },
            // computed KEEPS GENERIC FORM WRITES OFF THE JSON - THE BOT TAB'S
            // SAVE ROUTE COERCES EXTENTS BY DESCRIPTOR AND WRITES PARTIALLY
            extents_json: { type: FIELD_TYPES.JSON, hidden: true, computed: true, label: "Extents", description: "Sparse per-feature params, keys declared by the feature descriptor" },
            created_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Created At", description: "Timestamp when this rule was created" },
            updated_at: { type: FIELD_TYPES.TIMESTAMP, computed: true, readonly: true, label: "Updated At", description: "Timestamp when this rule was last updated" },
            server: { type: FIELD_TYPES.RELATION, hidden: true, label: "Server Reference", description: "Reference to the scoped Discord server" }
        }
    }
};

module.exports = {
    MODEL_TYPES,
    FIELD_TYPES,
    MODELS_META
};
