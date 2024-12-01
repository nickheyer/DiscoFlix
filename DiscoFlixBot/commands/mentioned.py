from openai import AsyncOpenAI
import random
from DiscoFlixBot.base_command import Command

class MentionedCommand(Command):
    # Special non-standard command registered for scenarios when the bot itself is mentioned
    
    def __init__(self) -> None:
        super().__init__()
        self.name = "mentioned"
        self.permissions = ["user", "developer"]
        self.description = "A fairly simple interface for openai. Great for recommending movies and tv shows."
        self.conditions = ["is_mention_enabled"]
        self.aliases = ["mentioned"]
        self.slash_enabled = False
        self.invokable = False
        

    async def execute(self, message, ctx):
        content = message.content.strip()
        
        general_responses = [
            "You called? 🤔",
            "I'm here! What do you need? 😄",
            "At your service! 🛠️",
            "Did someone summon me? 🧙‍♂️",
        ]
        bot_response = random.choice(general_responses)  # FALLBACK FOR THE MAJORITY THAT WONT USE THIS FEATURE
        try:
            token = getattr(ctx.config, 'openai_token', '')
            if len(token) > 0 and getattr(ctx.config, 'is_openai_enabled', False):
                # CHECK MENTIONS, CONVERT TO STR USERS
                for user in message.mentions:
                    mention_str = f'<@{user.id}>'
                    content = content.replace(mention_str, f'@{user.name}')
                
                # UNCLE GIPPITY
                client = AsyncOpenAI(
                        api_key = token
                )
                    
                chat_completion = await client.chat.completions.create(
                    model="gpt-3.5-turbo",   #"gpt-4o-mini",
                    messages=[
                        {"role": "system",
                         "content": f"""You are a fun and clever discord chatbot named {ctx.bot.client.user}, specializing in movies, games, and TV shows,
                         Keep the tone engaging, clever, and fun. Your response will be displayed within a Discord chat message, so keep the format in mind.
                         """
                         },
                        {
                            "role": "user",
                            "content": f"The following message was sent by a discord user: '{content}'\n"
                        }
                    ], # PROMPT WAS ACTUALLY CO-AUTHORED BY CHAT GPT, I WONDER IF THIS IS EVEN GOOD.
                    max_tokens=150,
                    temperature=0.8,
                    n=1,
                    top_p=0.9,
                    frequency_penalty=0.2,
                    presence_penalty=0.6,
                    user=f'{ctx.username}'
                )
                
                bot_response = chat_completion.choices[0].message.content.strip()
        except Exception as e:
            print(f"Error with OpenAI API: {e}")

        await message.channel.send(bot_response)
