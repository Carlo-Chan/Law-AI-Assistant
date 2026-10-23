"""日志回归测试：验证配置隔离、分级、异常定位与敏感内容保护。"""

import logging
import sys
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, ToolMessage
from pydantic import ValidationError

from app.agent import chain, retriever, tools
from app.api import routes
from app.core.config import Settings
from app.core.logging import SafeExceptionFormatter, configure_logging
from app.main import app


@pytest.fixture
def application_logger():
    """只隔离应用日志配置，结束后恢复原处理器及级别，不修改根日志器。"""
    logger = logging.getLogger("app")
    original_handlers = logger.handlers[:]
    original_level = logger.level
    original_propagate = logger.propagate
    logger.handlers = []
    try:
        yield logger
    finally:
        for handler in logger.handlers:
            if handler.get_name() == "law-ai-console":
                handler.close()
        logger.handlers = original_handlers
        logger.setLevel(original_level)
        logger.propagate = original_propagate


@pytest.mark.parametrize("level", ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"])
def test_log_level_accepts_supported_values(monkeypatch, level):
    """日志级别可通过环境变量设置，仍由 Pydantic 统一校验。"""
    monkeypatch.setenv("APP_LOG_LEVEL", level)
    assert Settings().app_log_level == level


def test_log_level_defaults_to_info(monkeypatch):
    """未配置日志级别时使用 INFO，默认不输出详细追踪。"""
    monkeypatch.delenv("APP_LOG_LEVEL")
    assert Settings().app_log_level == "INFO"


@pytest.mark.parametrize("level", ["", "VERBOSE", "info"])
def test_log_level_rejects_invalid_values(monkeypatch, level):
    """配置错误明确报错，不静默忽略或误用日志级别。"""
    monkeypatch.setenv("APP_LOG_LEVEL", level)
    with pytest.raises(ValidationError):
        Settings()


def test_logging_configuration_is_idempotent_and_preserves_host_loggers(application_logger):
    """重复配置不增加控制台处理器，根日志器和 Uvicorn 日志保持原样。"""
    host_loggers = [logging.getLogger(), logging.getLogger("uvicorn")]
    original_state = [
        (logger.handlers[:], logger.level, logger.propagate) for logger in host_loggers
    ]

    configure_logging("INFO")
    original_handler = next(
        handler for handler in application_logger.handlers if handler.get_name() == "law-ai-console"
    )
    original_application_handlers = application_logger.handlers[:]
    configure_logging("DEBUG")

    assert application_logger.handlers == original_application_handlers
    assert (
        sum(handler.get_name() == "law-ai-console" for handler in application_logger.handlers) == 1
    )
    assert isinstance(original_handler.formatter, SafeExceptionFormatter)
    assert application_logger.level == logging.DEBUG
    assert application_logger.propagate is False
    assert [
        (logger.handlers[:], logger.level, logger.propagate) for logger in host_loggers
    ] == original_state


def test_console_log_includes_level_and_module_without_duplicates(application_logger, capsys):
    """默认过滤 DEBUG，普通事件只输出一次并带有日志级别和模块名。"""
    configure_logging()
    configure_logging()
    logger = logging.getLogger("app.tests.logging")
    logger.debug("调试追踪")
    logger.info("业务事件")

    output = capsys.readouterr()
    assert not output.out
    assert "调试追踪" not in output.err
    assert output.err.count("业务事件") == 1
    assert "INFO app.tests.logging 业务事件" in output.err


def test_exception_stack_omits_messages_locals_and_cached_text(application_logger, capsys):
    """保留异常链及定位行号，不泄露异常消息、局部变量或其他处理器缓存的文本。"""
    configure_logging()
    formatter = next(
        handler.formatter
        for handler in application_logger.handlers
        if handler.get_name() == "law-ai-console"
    )
    private_content = "敏感合同正文与 sk-private-api-key"
    try:
        try:
            raise ValueError(private_content)
        except ValueError as error:
            raise RuntimeError(private_content) from error
    except RuntimeError:
        application_logger.exception("服务调用失败")
        record = logging.makeLogRecord(
            {"msg": "失败", "exc_info": sys.exc_info(), "exc_text": private_content}
        )
        formatted = formatter.format(record)

    output = capsys.readouterr().err
    for text in (output, formatted):
        assert "ValueError" in text
        assert "RuntimeError" in text
        assert "test_exception_stack_omits_messages_locals_and_cached_text" in text
        assert "第 " in text
        assert private_content not in text
    assert record.exc_text == private_content


@pytest.mark.asyncio
async def test_chat_logs_metadata_without_query_arguments_or_reply(
    application_logger, monkeypatch, capsys
):
    """即使开启 DEBUG，也仅记录长度及工具名称，回复与工具返回保持不变。"""
    configure_logging("DEBUG")
    private_content = "私密咨询内容及合同条款"
    messages = [
        AIMessage(
            content="",
            tool_calls=[
                {"id": "call-test", "name": "search_web", "args": {"query": private_content}}
            ],
        ),
        ToolMessage(content=private_content, name="search_web", tool_call_id="call-test"),
        AIMessage(content=private_content),
    ]
    monkeypatch.setattr(chain.chat_agent, "ainvoke", AsyncMock(return_value={"messages": messages}))

    result = await chain.run_chat(private_content)

    captured = capsys.readouterr()
    output = captured.err
    assert not captured.out
    assert result["reply"] == private_content
    assert result["sources"][0]["snippet"] == private_content
    assert "search_web" in output
    assert "法律咨询完成" in output
    assert private_content not in output


def test_unmatched_quote_warning_does_not_expose_contract(application_logger, capsys):
    """匹配降级有警告但不打印模型引用的原文，仍保留原有返回行为。"""
    configure_logging()
    private_content = "未匹配的敏感合同条款"

    result = chain._post_process_risks("原文", [{"key_phrase": private_content}])

    output = capsys.readouterr().err
    assert result[0]["quote"] == private_content
    assert "WARNING" in output
    assert "风险引用未匹配原文" in output
    assert private_content not in output


def test_bm25_initialization_failure_is_logged_without_exception_details(
    application_logger, monkeypatch, capsys
):
    """初始化降级仅输出异常类型，不触发真实向量库或打印敏感异常消息。"""
    configure_logging()
    private_content = "数据库异常中的私密数据"
    collection = Mock()
    collection.get.side_effect = RuntimeError(private_content)
    monkeypatch.setattr(retriever, "_collection", collection)
    monkeypatch.setattr(retriever, "_bm25", None)
    monkeypatch.setattr(retriever, "_bm25_docs", [])

    retriever._build_bm25()

    output = capsys.readouterr().err
    assert retriever._bm25 is None
    assert retriever._bm25_docs == []
    assert "BM25 索引构建失败" in output
    assert "RuntimeError" in output
    assert private_content not in output


def test_search_failure_keeps_return_value_and_logs_safe_warning(
    application_logger, monkeypatch, capsys
):
    """工具失败时保留旧的降级返回值，服务端日志不输出异常消息中的密钥。"""
    configure_logging()
    private_content = "sk-private-search-key"
    monkeypatch.setattr(
        tools, "_tavily", Mock(raw_results=Mock(side_effect=RuntimeError(private_content)))
    )

    result = tools.search_web.invoke({"query": "咨询问题"})

    output = capsys.readouterr().err
    assert result == f"搜索服务异常: {private_content}"
    assert "WARNING" in output
    assert "联网搜索服务异常" in output
    assert "RuntimeError" in output
    assert private_content not in output


def test_api_failure_keeps_response_and_logs_safe_error(application_logger, monkeypatch, capsys):
    """API 异常增加 ERROR 留痕，不改变 HTTP 响应，也不向日志写入用户正文。"""
    configure_logging()
    private_content = "用户与供应商异常中的敏感正文"
    monkeypatch.setattr(routes, "run_chat", AsyncMock(side_effect=RuntimeError(private_content)))

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"query": private_content})

    output = capsys.readouterr().err
    assert response.status_code == 500
    assert response.json()["detail"] == private_content
    assert "ERROR" in output
    assert "法律咨询请求处理失败" in output
    assert "RuntimeError" in output
    assert private_content not in output
