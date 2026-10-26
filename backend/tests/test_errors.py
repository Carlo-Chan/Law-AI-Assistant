"""错误边界回归：普通响应、流式响应、工具降级与消息存储均不暴露原始异常。"""

import json
from unittest.mock import AsyncMock, Mock

import httpx
import openai
import pytest
import requests
from fastapi.testclient import TestClient
from langgraph.errors import GraphRecursionError

from app.agent import tools
from app.api import routes
from app.core.errors import (
    CONFIGURATION_ERROR,
    CONNECTION_ERROR,
    INTERNAL_ERROR,
    INVALID_DOCUMENT,
    INVALID_REPORT,
    INVALID_REQUEST,
    PROCESSING_LIMIT,
    RATE_LIMIT_ERROR,
    TIMEOUT_ERROR,
    UPSTREAM_ERROR,
    UPSTREAM_REJECTED,
    PublicError,
    describe_error,
)
from app.main import app

PRIVATE = "sk-private-key 敏感合同正文 E:/private/internal/config.py"
REQUEST = httpx.Request("POST", "https://example.test/?key=sk-private-key")


def _status_error(adapter, status):
    """构造真实客户端异常类型，不发起请求。"""
    if adapter == "requests":
        response = requests.Response()
        response.status_code = status
        response._content = PRIVATE.encode()
        return requests.HTTPError(PRIVATE, response=response)
    response = httpx.Response(status, request=REQUEST, json={"private": PRIVATE})
    if adapter == "openai":
        return openai.APIStatusError(PRIVATE, response=response, body={"private": PRIVATE})
    return httpx.HTTPStatusError(PRIVATE, request=REQUEST, response=response)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (RuntimeError(PRIVATE), INTERNAL_ERROR),
        (ValueError("401 authentication " + PRIVATE), INTERNAL_ERROR),
        (requests.HTTPError(PRIVATE), UPSTREAM_ERROR),
        (TimeoutError(PRIVATE), TIMEOUT_ERROR),
        (httpx.ReadTimeout(PRIVATE), TIMEOUT_ERROR),
        (requests.Timeout(PRIVATE), TIMEOUT_ERROR),
        (openai.APITimeoutError(request=REQUEST), TIMEOUT_ERROR),
        (httpx.ConnectError(PRIVATE), CONNECTION_ERROR),
        (requests.exceptions.SSLError(PRIVATE), CONNECTION_ERROR),
        (openai.APIConnectionError(message=PRIVATE, request=REQUEST), CONNECTION_ERROR),
        (GraphRecursionError(PRIVATE), PROCESSING_LIMIT),
        (PublicError(INVALID_REPORT), INVALID_REPORT),
    ],
)
def test_exception_classification_never_uses_private_message(error, expected):
    """只识别已知异常类型；文本像认证错误的普通 ValueError 也不能被猜测分类。"""
    assert describe_error(error) == expected
    assert PRIVATE not in json.dumps(expected.stream_event(), ensure_ascii=False)


@pytest.mark.parametrize("adapter", ["httpx", "requests", "openai"])
@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, CONFIGURATION_ERROR),
        (403, CONFIGURATION_ERROR),
        (429, RATE_LIMIT_ERROR),
        (408, TIMEOUT_ERROR),
        (504, TIMEOUT_ERROR),
        (400, UPSTREAM_REJECTED),
        (404, UPSTREAM_REJECTED),
        (500, UPSTREAM_ERROR),
        (503, UPSTREAM_ERROR),
    ],
)
def test_upstream_status_is_classified_without_body_or_url(adapter, status, expected):
    """供应商状态不等同于本站用户权限；密钥、响应正文和 URL 不参与输出。"""
    assert describe_error(_status_error(adapter, status)) == expected


@pytest.fixture
def client(history_store):
    """不关闭异常上抛检测，确保 API 边界已实际处理错误而非依赖服务器兜底。"""
    with TestClient(app) as test_client:
        yield test_client


@pytest.mark.parametrize("mode", ["chat", "contract"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (RuntimeError(PRIVATE), INTERNAL_ERROR),
        (httpx.ReadTimeout(PRIVATE), TIMEOUT_ERROR),
        (httpx.ConnectError(PRIVATE), CONNECTION_ERROR),
        (_status_error("openai", 401), CONFIGURATION_ERROR),
        (_status_error("openai", 429), RATE_LIMIT_ERROR),
        (GraphRecursionError(PRIVATE), PROCESSING_LIMIT),
        (PublicError(INVALID_REPORT), INVALID_REPORT),
    ],
)
def test_http_and_sse_share_safe_errors(client, monkeypatch, mode, stream, error, expected):
    """未开始流时返回对应 HTTP 状态；流开始后只发一个错误帧，不伪造完成帧。"""
    agent_name = "run_chat" if mode == "chat" else "run_contract_analysis"
    if stream:

        async def generate(*args):
            yield {"type": "token", "content": "已有内容"}
            raise error

        monkeypatch.setattr(routes, agent_name + "_stream", generate)
    else:
        monkeypatch.setattr(routes, agent_name, AsyncMock(side_effect=error))
    endpoint = "/api/chat" if mode == "chat" else "/api/analyze_contract"
    if stream:
        endpoint += "/stream"
    kwargs = (
        {"json": {"query": "普通咨询"}}
        if mode == "chat"
        else {"files": {"file": ("合同.txt", "合同内容".encode())}}
    )

    response = client.post(endpoint, **kwargs)

    assert PRIVATE not in response.text
    assert "sk-private-key" not in response.text
    if stream:
        assert response.status_code == 200
        events = [
            json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
        ]
        assert events == [{"type": "token", "content": "已有内容"}, expected.stream_event()]
    else:
        assert response.status_code == expected.status_code
        assert response.json() == {"detail": expected.message, "code": expected.code}


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("error", [ValueError(PRIVATE), RuntimeError(PRIVATE)])
def test_parser_exceptions_are_not_trusted_public_messages(client, monkeypatch, stream, error):
    """第三方 ValueError 不能像应用自己的格式提示一样直接返回。"""
    parser = Mock(side_effect=error)
    monkeypatch.setattr(routes.DocumentParser, "parse_document", parser)
    agent = AsyncMock()
    monkeypatch.setattr(routes, "run_contract_analysis", agent)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", agent)

    response = client.post(
        "/api/analyze_contract" + ("/stream" if stream else ""),
        files={"file": ("合同.pdf", b"invalid")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == INVALID_DOCUMENT.message
    assert PRIVATE not in response.text
    agent.assert_not_called()


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("filename", ["损坏.pdf", "损坏.doc", "损坏.docx", "合同.sk-private-key"])
def test_real_invalid_document_returns_safe_http_error(client, stream, filename):
    """损坏文件与异常扩展名不暴露解析器详情或文件名，SSE 开始前即可拒绝。"""
    response = client.post(
        "/api/analyze_contract" + ("/stream" if stream else ""),
        files={"file": (filename, b"not-a-document")},
    )
    assert response.status_code == 400
    assert "sk-private-key" not in response.text
    assert response.headers["content-type"].startswith("application/json")


def test_validation_failure_does_not_echo_input(client):
    """请求参数校验失败也不回传包含正文的 Pydantic input 字段。"""
    response = client.post("/api/chat", json={"query": {"private": PRIVATE}})
    assert response.status_code == 422
    assert response.json() == {"detail": INVALID_REQUEST.message, "code": INVALID_REQUEST.code}
    assert PRIVATE not in response.text


def test_openapi_documents_safe_validation_response(client):
    """接口文档也使用新的 422 响应结构，而非默认包含 input 的校验详情。"""
    schema = client.get("/openapi.json").json()
    response_schema = schema["paths"]["/api/chat"]["post"]["responses"]["422"]["content"][
        "application/json"
    ]["schema"]
    assert response_schema["$ref"].endswith("/ErrorResponse")
    assert schema["components"]["schemas"]["ErrorResponse"]["required"] == ["detail", "code"]


def test_history_failure_has_safe_response(client, monkeypatch):
    """会话路由同样受异常边界保护，不返回 SQLite 内部路径。"""
    monkeypatch.setattr(
        routes.history, "list_conversations", Mock(side_effect=RuntimeError(PRIVATE))
    )
    response = client.get("/api/conversations")
    assert response.status_code == 500
    assert response.json()["detail"] == INTERNAL_ERROR.message
    assert PRIVATE not in response.text


def test_safe_failure_message_can_still_be_saved_and_reloaded(client, monkeypatch):
    """错误帧保持 message 字段，前端生成的失败气泡仍可按原消息接口持久化。"""

    async def generate(*args):
        raise httpx.ReadTimeout(PRIVATE)
        yield

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    response = client.post("/api/chat/stream", json={"query": "咨询问题"})
    event = json.loads(response.text.splitlines()[0][6:])
    content = "### ⚠️ 请求失败\n\n" + event["message"]
    conv_id = client.post("/api/conversations").json()["data"]["id"]
    url = f"/api/conversations/{conv_id}"
    assert (
        client.post(
            url + "/messages",
            json={
                "user_content": "咨询问题",
                "assistant_content": content,
            },
        ).status_code
        == 200
    )
    saved = client.get(url).json()["data"]["messages"]
    assert len(saved) == 2
    assert saved[-1]["content"] == content
    assert PRIVATE not in saved[-1]["content"]


@pytest.mark.parametrize("name", ["search_web", "verify_legal"])
def test_tool_errors_do_not_enter_model_context(monkeypatch, name):
    """两个工具保留失败语义，但不再将完整异常当作工具结果交给模型。"""
    monkeypatch.setattr(
        tools, "_tavily", Mock(raw_results=Mock(side_effect=requests.exceptions.SSLError(PRIVATE)))
    )
    monkeypatch.setattr(tools, "_yd_rest", Mock(side_effect=httpx.ReadTimeout(PRIVATE)))
    result = getattr(tools, name).invoke(
        {"query": "问题"} if name == "search_web" else {"text": "法条引用"}
    )
    assert PRIVATE not in result
    assert "未完成" in result
    assert "不要反复调用同一工具" in result


def test_legal_search_distinguishes_outage_from_no_results(monkeypatch):
    """双路检索异常不能被描述为确实不存在相关法规。"""
    monkeypatch.setattr(tools, "_yd_rest", Mock(side_effect=RuntimeError(PRIVATE)))
    monkeypatch.setattr(tools, "_yd_mcp", Mock(side_effect=RuntimeError(PRIVATE)))
    result = tools.search_legal.invoke({"query": "押金"})
    assert PRIVATE not in result
    assert "未完成" in result
    assert "未检索到相关结果" not in result


def test_legal_search_preserves_partial_results(monkeypatch):
    """语义检索成功时保留已有法条，即使补充关键词检索失败也不抹掉结果。"""
    monkeypatch.setattr(
        tools,
        "_yd_rest",
        Mock(
            return_value={
                "code": 201,
                "extra": {"fatiao": [{"fgtitle": "示例法", "content": "有效结果"}]},
            }
        ),
    )
    monkeypatch.setattr(tools, "_yd_mcp", Mock(side_effect=RuntimeError(PRIVATE)))
    result = tools.search_legal.invoke({"query": "押金"})
    assert "有效结果" in result
    assert PRIVATE not in result


def test_legal_search_keeps_real_empty_result(monkeypatch):
    """服务正常且两路结果均为空时，仍使用正常的查无结果提示。"""
    monkeypatch.setattr(
        tools, "_yd_rest", Mock(return_value={"code": 201, "extra": {"fatiao": []}})
    )
    monkeypatch.setattr(tools, "_yd_mcp", Mock(return_value={"result": {"content": []}}))
    assert tools.search_legal.invoke({"query": "押金"}) == "元典智库未检索到相关结果。"


def test_web_search_preserves_successful_sources(monkeypatch):
    """联网搜索成功时仍保留标题、摘要和来源，不被错误分类影响。"""
    monkeypatch.setattr(
        tools,
        "_tavily",
        Mock(
            raw_results=Mock(
                return_value={
                    "results": [
                        {
                            "title": "示例案例",
                            "url": "https://example.test/case",
                            "content": "公开摘要",
                        }
                    ],
                }
            )
        ),
    )
    result = tools.search_web.invoke({"query": "押金"})
    assert result == "[1] 示例案例\n公开摘要\n来源: https://example.test/case"


def test_verification_preserves_successful_conclusion(monkeypatch):
    """校验成功仍返回语义及有效性结论，不与服务异常混淆。"""
    monkeypatch.setattr(
        tools,
        "_yd_rest",
        Mock(
            return_value={
                "regulations": [
                    {
                        "name": "示例法",
                        "clause": "第一条",
                        "semantic_compare": {"结论": "一致"},
                        "validity_status": "现行有效",
                    }
                ]
            }
        ),
    )
    result = tools.verify_legal.invoke({"text": "法条引用"})
    assert "语义=一致" in result
    assert "时效性=现行有效" in result
