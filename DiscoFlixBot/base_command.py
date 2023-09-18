class Command:
    """
    --- CLASS FIELD DESCRIPTIONS ---  [ SEE BELOW ]
    name: Command name.
    permissions: Currently allowed options are [ unregistered, user, admin, developer, owner ].
    slash_enabled: Allow slash command usage.
    aliases: Parsed commands allowed, ie: !df movie == !df film if ['movie', 'film'].
    description: Description to be given in help menu.
    requires_input: If command requires input following the command.
    conditions: Can take 3 different data-types as input...
      - tuple: (function, arguments-for-function)
      - function: function that returns truthy/falsey value
      - string: refers to settings/configuration value in DB, ie: 'is_radarr_enabled'
    """
        
    name = None
    permissions = []
    slash_enabled = True
    aliases = []
    description = ''
    requires_input = False
    conditions = []


    """
    --- CLASS METHOD ARGUMENTS DESCRIPTIONS --- [ SEE BELOW ]

    message: The original Discord Message instance.
      - .channel: The Discord channel that the message is in.
        - .reply: Reply to the message in that channel.
        - .send: Send to the channel that the message is in.
      - .

    ctx: The parsed message object returned from parser.py
      - .primary: The text following the command, ie: "!df echo <this is the primary argument>"
      - .bot = The Discord bot client instance.
      - .message = The Discord message object (same as first argument)
      - .message_content = The text content of the Discord message
      - .server_id = The ID of the Discord server: message.guild.id
      - .config = The Configuration object. It includes the merged user-specific settings.
      - .is_slash = Is the incoming message a slash command.
      - .valid = Is this a valid message.
    """

    async def execute(self, message, ctx):
        pass

    @classmethod
    def from_dict(cls, data):
        return cls(**data)