from pathlib import Path
import uuid
import os
import shutil
import json


def get_project_root() -> Path:
    return Path(__file__).absolute().parent.parent.parent


def initialize_dirs():
    root = get_project_root()
    os.makedirs(os.path.join(root, "data"), exist_ok=True)
    os.makedirs(os.path.join(root, "log", "bug-reports"), exist_ok=True)
    os.makedirs(os.path.join(root, "log", "debug"), exist_ok=True)


def get_data_path() -> Path:
    root = get_project_root()
    return root.joinpath("data")


def get_db_file() -> Path:
    data_dir = get_data_path()
    return data_dir.joinpath("disco.db")


def get_bug_report_path(channel) -> Path:
    root = get_project_root()
    dir_path = root.joinpath("log", "bug-reports")
    file_path = dir_path.joinpath(f"ERR_{channel}_{uuid.uuid4()}.log")
    return file_path


def get_debug_dir_path() -> Path:
    root = get_project_root()
    dir_path = root.joinpath("log", "debug")
    return dir_path


def get_venv_python_dict() -> dict:
    root = get_project_root()
    return root.joinpath("venv")


def concat_path(*args):
    return Path(*args)


def move_file(src, dest):
    move = shutil.move(src, dest)
    return move


def delete_file(target):
    os.remove(target)


def check_file_exists(full_path):
    return os.path.isfile(full_path)


def generate_debug_file(debug: dict) -> Path:
    file_name = f"{uuid.uuid4()}.json"
    file_path = get_debug_dir_path().joinpath(file_name)
    with open(file_path, "w") as fp:
        json.dump(debug, indent=4, fp=fp)
    return file_path
