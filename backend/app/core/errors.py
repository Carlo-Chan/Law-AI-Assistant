"""面向用户的固定错误描述，禁止根据供应商异常正文拼接提示。"""

from dataclasses import dataclass

import httpx
import openai
import requests
from langgraph.errors import GraphRecursionError


@dataclass(frozen=True)
class ErrorInfo:
    code: str
    message: str
    status_code: int

    def stream_event(self) -> dict:
        return {"type": "error", "message": self.message, "code": self.code}


INTERNAL_ERROR = ErrorInfo("internal_error", "服务暂时不可用，请稍后重试。", 500)
CONNECTION_ERROR = ErrorInfo(
    "connection_error", "暂时无法连接服务，请稍后重试；若持续失败，请联系管理员检查服务连接。", 503
)
TIMEOUT_ERROR = ErrorInfo("service_timeout", "服务响应超时，请稍后重试。", 504)
CONFIGURATION_ERROR = ErrorInfo(
    "service_configuration", "服务配置或访问权限异常，请联系管理员检查配置。", 503
)
RATE_LIMIT_ERROR = ErrorInfo(
    "service_rate_limit",
    "服务请求过于频繁或额度暂不可用，请稍后重试；若持续出现，请联系管理员。",
    429,
)
UPSTREAM_ERROR = ErrorInfo("upstream_error", "上游服务暂时异常，请稍后重试。", 502)
UPSTREAM_REJECTED = ErrorInfo(
    "upstream_rejected", "服务未能处理本次请求，请缩短输入后重试；若持续失败，请联系管理员。", 502
)
PROCESSING_LIMIT = ErrorInfo(
    "processing_limit", "本次任务已达到处理步骤上限，请缩小问题范围后重试。", 503
)
INVALID_REPORT = ErrorInfo(
    "invalid_report", "审查报告格式异常，请重试；若持续失败，请联系管理员。", 502
)
INVALID_DOCUMENT = ErrorInfo(
    "invalid_document",
    "文件解析失败，请确认文件未损坏、未加密，或转换为 PDF / DOCX / TXT 后重试。",
    400,
)
UNSUPPORTED_DOCUMENT = ErrorInfo(
    "unsupported_document", "不支持的文件格式，仅支持 PDF / DOCX / TXT。", 400
)
LEGACY_DOCUMENT = ErrorInfo("legacy_document", "不支持旧版 .doc 格式，请转换为 .docx 后重试", 400)
INVALID_REQUEST = ErrorInfo("invalid_request", "请求参数不正确，请检查后重试。", 422)
CONTRACT_INSTRUCTION_TOO_LONG = ErrorInfo(
    "contract_instruction_too_long", "附加审查指令不能超过 4000 字，请缩短后重试。", 422
)
REPORT_NOT_FOUND = ErrorInfo("report_not_found", "目标合同报告不存在，请刷新会话后重试。", 404)
CONVERSATION_NOT_FOUND = ErrorInfo("conversation_not_found", "会话不存在", 404)
TITLE_CHANGED = ErrorInfo("title_changed", "标题已在其他位置修改，请确认最新标题后再保存。", 409)
MESSAGE_NOT_FOUND = ErrorInfo("message_not_found", "目标消息不存在，请刷新会话后重试。", 404)
MESSAGE_CHANGED = ErrorInfo(
    "message_changed", "目标消息已变更，请刷新会话后重试；本次未修改任何记录。", 409
)
MESSAGE_NOT_EDITABLE = ErrorInfo("message_not_editable", "仅支持编辑用户消息。", 400)
REPLY_CHANGED = ErrorInfo(
    "reply_changed", "原回复或生成上下文已变更，请重新读取会话；本次结果未覆盖原记录。", 409
)
REPLY_SOURCE_MISSING = ErrorInfo(
    "reply_source_missing", "此回复缺少可用的对应问题，无法重新生成；原回复已保留。", 400
)
REPLY_NOT_SUPPORTED = ErrorInfo(
    "reply_not_supported", "此记录属于合同审查，请使用合同重新审查；原记录未修改。", 400
)
INVALID_REPLY = ErrorInfo("invalid_reply", "未收到完整咨询回复，原回复已保留，请重试。", 502)
REPORT_CHANGED = ErrorInfo(
    "report_changed", "原报告已变更或被删除，请刷新会话后重试；本次结果未覆盖原记录。", 409
)
CONTRACT_SOURCE_MISSING = ErrorInfo(
    "contract_source_missing", "此记录未保存合同原文，请重新上传原文件；原报告已保留。", 400
)


class PublicError(ValueError):
    """由应用主动抛出的业务错误，只携带固定描述，兼容原有 ValueError 调用方。"""

    def __init__(self, info: ErrorInfo):
        self.info = info
        super().__init__(info.message)


def describe_error(error: Exception) -> ErrorInfo:
    """仅按异常类型和 HTTP 状态分类；未知或被包装的异常安全降级，不猜测正文。"""
    if isinstance(error, PublicError):
        return error.info
    if isinstance(error, GraphRecursionError):
        return PROCESSING_LIMIT
    if isinstance(
        error, (TimeoutError, httpx.TimeoutException, openai.APITimeoutError, requests.Timeout)
    ):
        return TIMEOUT_ERROR
    if isinstance(
        error,
        (
            ConnectionError,
            httpx.TransportError,
            openai.APIConnectionError,
            requests.ConnectionError,
        ),
    ):
        return CONNECTION_ERROR
    if isinstance(error, (openai.APIStatusError, httpx.HTTPStatusError, requests.HTTPError)):
        response = error.response
        status = response.status_code if response is not None else None
        if status in (401, 403):
            return CONFIGURATION_ERROR
        if status == 429:
            return RATE_LIMIT_ERROR
        if status in (408, 504):
            return TIMEOUT_ERROR
        if status is not None and 400 <= status < 500:
            return UPSTREAM_REJECTED
        return UPSTREAM_ERROR
    return INTERNAL_ERROR


def tool_failure(service: str, error: Exception) -> str:
    """工具失败不能伪装成查无结果，也不能让原始异常进入模型上下文。"""
    info = describe_error(error)
    return (
        f"{service}未完成：{info.message}"
        "本次未取得有效结果，请勿将其视为检索或校验成功，也不要反复调用同一工具。"
    )
