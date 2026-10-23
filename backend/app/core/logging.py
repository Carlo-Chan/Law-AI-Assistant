"""配置应用日志，保留定位信息但不输出异常详情或局部变量。"""

import logging
import traceback
from copy import copy

_HANDLER_NAME = "law-ai-console"


def _format_exception_stack(error):
    """保留异常链、文件及行号，避免第三方异常携带合同正文或 API Keys。"""
    parts = []
    previous = error.__cause__
    if previous is None and not error.__suppress_context__:
        previous = error.__context__
    if previous is not None:
        parts.append(_format_exception_stack(previous))
        parts.append("上述异常引发了后续异常：\n")
    parts.append("异常调用栈（已省略异常详情及局部变量）：\n")
    for frame in error.stack:
        parts.append(f"  文件 {frame.filename}，第 {frame.lineno} 行，函数 {frame.name}\n")
    exception_name = (
        error.exc_type_str if hasattr(error, "exc_type_str") else error.exc_type.__name__
    )
    parts.append(f"{exception_name}\n")
    for nested in getattr(error, "exceptions", None) or []:
        parts.append(_format_exception_stack(nested))
    return "".join(parts).rstrip() + "\n"


class SafeExceptionFormatter(logging.Formatter):
    """异常只输出调用位置和类型，不输出可能含敏感内容的异常消息。"""

    def format(self, record):
        safe_record = copy(record)
        safe_record.exc_text = None
        return super().format(safe_record)

    def formatException(self, exception_info):
        error = traceback.TracebackException(
            *exception_info, capture_locals=False, lookup_lines=False
        )
        return _format_exception_stack(error).rstrip()


def configure_logging(level: str = "INFO") -> None:
    """只配置 app 命名空间；重复调用不叠加处理器，也不接管 Uvicorn 日志。"""
    logger = logging.getLogger("app")
    logger.setLevel(level)
    logger.propagate = False
    handler = next(
        (handler for handler in logger.handlers if handler.get_name() == _HANDLER_NAME), None
    )
    if handler is None:
        handler = logging.StreamHandler()
        handler.set_name(_HANDLER_NAME)
        logger.addHandler(handler)
    handler.setFormatter(
        SafeExceptionFormatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
        )
    )
