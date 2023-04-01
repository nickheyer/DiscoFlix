from models.models import (
    Configuration
)

def config():
    return Configuration.get()