from bot.user_manager import get_users_for_auth

class Message_Handler:
    def __init__(self, message, message_map, config) -> None:
        self.message = message
        self.message_content = message.content
        self.server_id = message.guild.id
        self.message_map = message_map
        self.config = config
        self.valid = self.__parse_message()

    def __parse_message(self):
        if (not self.__parse_sender()
        or not self.__parse_prefix()
        or not self.__parse_command()
        or not self.__parse_permissions()
        or not self.__parse_requirements()
        or not self.__parse_args()):
            return False
        return True

    def __parse_sender(self):
        self.sender = self.message.author
        self.username = str(self.message.author)
        self.is_bot = self.sender.bot
        return not self.is_bot

    def __parse_prefix(self):
        prefix = self.config.prefix_keyword
        split = self.message_content.strip().split(' ')
        return len(split) > 1 and split[0] == prefix

    def __parse_command(self):
        self.split_message = self.message_content.strip().split(' ')
        if len(self.split_message) < 2:
            self.command = None
        else:
            for command in self.message_map:
                commands = self.message_map[command]['aliases']
                if self.split_message[1].lower() in commands:
                    self.command = self.message_map[command]
                    return True
        return False

    def __parse_permissions(self):
        permissions = self.command.get('permissions', [])
        if not permissions:
            return True
        server = self.server_id
        approved_users = get_users_for_auth(server, permissions)
        return self.username in approved_users
    
    def __parse_requirements(self):
        requirements = self.command.get('requirements', [])
        for requirement in requirements:
            if type(requirement) == tuple:
                fn = requirement[0]
                result = fn(*requirement[1])
                if not result:
                    return False
            elif hasattr(requirement, '__call__'):
                fn = requirement
                result = fn()
                if not result:
                    return False
            elif type(requirement) == str:
                config_setting = getattr(self.config, requirement, False)
                if not config_setting:
                    return False
            else:
                if not requirement:
                    return False
        return True

    def __parse_options(self):
        options = {}
        cmd_args = self.command.get('args', {})
        valid_options = cmd_args.get('additional', [])
        message_args = self.split_message[2:]
        for option in valid_options:
            ref = option['ref']
            remaining_aliases = [alias for other_option in valid_options 
                                    if other_option['ref'] != ref and 
                                    other_option['ref'] not in options.keys()
                                    for alias in other_option['aliases']]
            formatted_args = option['aliases']
            options[ref] = False
            for i, text in enumerate(message_args):
                if text in formatted_args:
                    if option['expect_content']:
                        content_list = []
                        # Find end of message or start of next option
                        if len(message_args[i:]) <= 1:
                            options[ref] = False
                            break
                        remaining_msg = message_args[i + 1:]
                        for val in remaining_msg:
                            if val in remaining_aliases:
                                break
                            else:
                                content_list.append(val)
                        if content_list == []:
                            options[ref] = False
                            break
                        else:
                            options[ref] = ' '.join(content_list)
                            break
                    else:
                        options[ref] = True
                        break

        return options

    def __parse_args(self):
        cmd_args = self.command.get('args', {})
        primary = cmd_args.get('primary', { 'used': False })
        self.primary = False
        if primary['used']:
            if primary['required'] and len(self.split_message) < 3:
                return False
            # Parse primary value
            primary_values = []
            all_aliases = [alias for option in self.command['args']['additional'] for alias in option['aliases']]
            for text in self.split_message[2:] if len(self.split_message) > 2 else []:
                if text in all_aliases:
                    break
                primary_values.append(text)
            self.primary = ' '.join(primary_values) if primary_values else None
            if primary['required'] and not self.primary:
                # Primary argument was not provided, even though it's required
                return False
        # Parse additional args
        args = self.__parse_options()
        for i, option in enumerate(args):
            if args[option] is False and self.command['args']['additional'][i]['required']:
                # An additional argument was not provided, even though it's required
                return False
        args['command'] = self.command
        args['requestor'] = self.sender
        args['primary'] = self.primary
        args['config'] = self.config
        self.args = args
        return True

    def generate_fn(self):
        fn = self.command['fn']
        self.fn = lambda: fn(self.message, self.args)
        return self.fn