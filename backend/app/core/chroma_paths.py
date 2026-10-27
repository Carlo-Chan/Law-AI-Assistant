"""统一 Chroma 持久化路径，不移动数据库或修改进程工作目录。"""

import sys
from os.path import relpath
from pathlib import Path

_IS_WINDOWS = sys.platform == "win32"
_UNSAFE_WINDOWS_PATH = (
    "当前 Windows 启动目录无法为 Chroma 生成安全路径，请切换至项目 backend 目录后启动。"
    "数据库不会被移动、重建或替换。"
)


def chroma_persist_path(directory: Path) -> str:
    """固定实际库位置，仅在 Windows 非 ASCII 路径下使用可安全解析的相对路径。"""
    absolute = directory.resolve()
    if not _IS_WINDOWS or str(absolute).isascii():
        return str(absolute)
    try:
        relative = relpath(absolute, Path.cwd())
    except ValueError:
        raise RuntimeError(_UNSAFE_WINDOWS_PATH) from None
    if not relative.isascii():
        raise RuntimeError(_UNSAFE_WINDOWS_PATH)
    return relative
