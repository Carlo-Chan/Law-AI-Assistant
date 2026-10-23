"""API 测试：真实 SQLite 与内存 HTTP 请求配合，AI 调用全部替换为 mock。"""

import json
import sqlite3
from contextlib import closing
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.main import app


@pytest.fixture
def client(history_store):
    """通过 ASGI 直接请求应用，不启动真实服务器。"""
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def test_health_endpoint(client):
    """健康检查无需访问外部服务。"""
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.1.0"}


def test_conversation_crud_round_trip(client):
    """会话从创建、保存、重命名和重建到删除可完整往返。"""
    assert client.get("/api/conversations").json()["data"] == []
    created = client.post("/api/conversations")
    assert created.status_code == 200
    conversation_id = created.json()["data"]["id"]
    url = f"/api/conversations/{conversation_id}"
    contract_data = {"raw_text": "合同原文", "risk_points": []}
    thinking_chain = [{"type": "tool", "content": "检索结果"}]

    saved = client.post(
        f"{url}/messages",
        json={
            "user_content": "帮我审查",
            "assistant_content": "审查报告",
            "file_name": "租赁合同.pdf",
            "contract_data": contract_data,
            "thinking_chain": thinking_chain,
        },
    )
    assert saved.status_code == 200
    detail = client.get(url)
    assert detail.status_code == 200
    messages = detail.json()["data"]["messages"]
    assert [message["content"] for message in messages] == ["帮我审查", "审查报告"]
    assert messages[0]["file_name"] == "租赁合同.pdf"
    assert json.loads(messages[1]["contract_data"]) == contract_data
    assert messages[1]["thinking_chain"] == thinking_chain

    assert client.post(f"{url}/title", json={"title": "合同审查记录"}).status_code == 200
    assert client.get(url).json()["data"]["title"] == "合同审查记录"
    assert client.get("/api/conversations").json()["data"][0]["id"] == conversation_id
    replacement = [{"role": "user", "content": "修改后的问题"}]
    assert client.post(f"{url}/rebuild", json={"messages": replacement}).status_code == 200
    assert [message["content"] for message in client.get(url).json()["data"]["messages"]] == [
        "修改后的问题",
    ]
    assert client.post(f"{url}/rebuild", json={"messages": []}).status_code == 200
    assert client.get(url).json()["data"]["messages"] == []
    assert client.delete(url).status_code == 200
    assert client.get(url).status_code == 404
    assert client.get("/api/conversations").json()["data"] == []


@pytest.mark.parametrize(
    ("suffix", "payload"),
    [
        ("title", {"title": "新标题"}),
        ("messages", {"user_content": "问题", "assistant_content": "回复"}),
        ("rebuild", {"messages": [{"role": "user", "content": "问题"}]}),
    ],
)
def test_writing_missing_conversation_returns_404(client, history_store, suffix, payload):
    """不存在的会话不能写入消息、重建消息或修改标题。"""
    response = client.post(f"/api/conversations/missing/{suffix}", json=payload)

    assert response.status_code == 404
    assert response.json()["detail"] == "会话不存在"
    assert history_store.list_conversations() == []


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"messages": None},
        {"messages": "not-a-list"},
        {"messages": [{"role": "user", "content": None}]},
        {"messages": [{"role": "system", "content": "不允许的角色"}]},
    ],
)
def test_invalid_rebuild_request_keeps_existing_messages(client, payload):
    """不合法的重建请求必须先被校验拒绝，不能误清空或部分覆盖原消息。"""
    conversation_id = client.post("/api/conversations").json()["data"]["id"]
    url = f"/api/conversations/{conversation_id}"
    client.post(f"{url}/messages", json={"user_content": "原问题", "assistant_content": "原回复"})
    before = client.get(url).json()["data"]

    response = client.post(f"{url}/rebuild", json=payload)

    assert response.status_code == 422
    assert client.get(url).json()["data"] == before


def test_message_pair_save_rolls_back_if_assistant_insert_fails(client, history_store):
    """同一轮问答的第二条消息写入失败时，不能留下半轮对话。"""
    conversation_id = client.post("/api/conversations").json()["data"]["id"]
    url = f"/api/conversations/{conversation_id}"
    before = client.get(url).json()["data"]
    with closing(sqlite3.connect(history_store.DB_PATH)) as connection, connection:
        connection.execute("""
            CREATE TRIGGER reject_assistant BEFORE INSERT ON messages
            WHEN NEW.role = 'assistant'
            BEGIN
                SELECT RAISE(ABORT, '模拟第二条消息写入失败');
            END
        """)

    response = client.post(
        f"{url}/messages",
        json={"user_content": "新问题", "assistant_content": "新回复"},
    )

    assert response.status_code == 500
    assert client.get(url).json()["data"] == before


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_chat_requires_query_before_calling_agent(client, monkeypatch, endpoint):
    """缺少问题字段时在调用 AI 前返回 422。"""
    agent = AsyncMock()
    stream_agent = Mock()
    monkeypatch.setattr(routes, "run_chat", agent)
    monkeypatch.setattr(routes, "run_chat_stream", stream_agent)

    assert client.post(endpoint, json={}).status_code == 422
    agent.assert_not_called()
    stream_agent.assert_not_called()


def test_chat_forwards_query_and_history(client, monkeypatch):
    """咨询接口保留问题及历史记录，按约定返回回复与来源。"""
    result = {"reply": "咨询回复", "sources": [{"tool": "search_laws", "snippet": "检索结果"}]}
    agent = AsyncMock(return_value=result)
    monkeypatch.setattr(routes, "run_chat", agent)
    past_messages = [{"role": "user", "content": "之前的问题"}]

    response = client.post("/api/chat", json={"query": "继续咨询", "history": past_messages})

    assert response.status_code == 200
    assert response.json() == {"code": 200, "data": result}
    agent.assert_awaited_once_with("继续咨询", past_messages)


def test_chat_agent_failure_returns_http_error(client, monkeypatch):
    """非流式 AI 异常转换为 HTTP 500。"""
    monkeypatch.setattr(routes, "run_chat", AsyncMock(side_effect=RuntimeError("服务暂不可用")))

    response = client.post("/api/chat", json={"query": "租房问题"})

    assert response.status_code == 500
    assert response.json()["detail"] == "服务暂不可用"


@pytest.mark.parametrize("endpoint", ["/api/analyze_contract", "/api/analyze_contract/stream"])
def test_contract_requires_uploaded_file(client, endpoint):
    """合同审查没有上传文件时返回 422。"""
    assert client.post(endpoint).status_code == 422


@pytest.mark.parametrize("endpoint", ["/api/analyze_contract", "/api/analyze_contract/stream"])
@pytest.mark.parametrize("filename", ["合同.doc", "程序.exe"])
def test_contract_invalid_format_does_not_call_agent(client, monkeypatch, endpoint, filename):
    """不支持的文件格式在调用 AI 前返回 400。"""
    agent = AsyncMock()
    stream_agent = Mock()
    monkeypatch.setattr(routes, "run_contract_analysis", agent)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", stream_agent)

    response = client.post(endpoint, files={"file": (filename, b"example")})

    assert response.status_code == 400
    assert "不支持" in response.json()["detail"]
    agent.assert_not_called()
    stream_agent.assert_not_called()


def test_contract_parses_upload_and_returns_risks(client, monkeypatch):
    """文件解析出的原文传入 AI，报告和高亮风险字段完整返回。"""
    raw_text = "甲方应退还押金。"
    result = {
        "raw_text": raw_text,
        "chat_reply": "审查报告",
        "risk_points": [{"quote": "退还押金", "level": "low", "bubble_text": "明确时间"}],
    }
    agent = AsyncMock(return_value=result)
    monkeypatch.setattr(routes, "run_contract_analysis", agent)

    response = client.post(
        "/api/analyze_contract",
        files={"file": ("合同.txt", raw_text.encode("utf-8"))},
    )

    assert response.status_code == 200
    assert response.json() == {"code": 200, "data": result}
    agent.assert_awaited_once_with(raw_text)


def test_contract_agent_failure_returns_http_error(client, monkeypatch):
    """合同审查 AI 失败时返回 HTTP 500。"""
    agent = AsyncMock(side_effect=RuntimeError("合同审查失败"))
    monkeypatch.setattr(routes, "run_contract_analysis", agent)

    response = client.post("/api/analyze_contract", files={"file": ("合同.txt", b"contract")})

    assert response.status_code == 500
    assert response.json()["detail"] == "合同审查失败"


def _read_events(response):
    """解码响应中的 SSE 数据帧。"""
    assert response.headers["content-type"].startswith("text/event-stream")
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


@pytest.mark.parametrize("mode", ["chat", "contract"])
def test_stream_preserves_event_order_and_unicode(client, monkeypatch, mode):
    """两类流式接口按顺序传递中文事件，结束帧保留结构化结果。"""
    events = [
        {"type": "thinking", "label": "search_laws"},
        {"type": "token", "content": "审查建议\n下一段"},
        {"type": "done"},
    ]
    if mode == "contract":
        events[-1].update({"raw_text": "合同原文", "risk_points": [], "chat_reply": "审查建议"})

    async def generate(*args):
        for event in events:
            yield event

    agent = Mock(side_effect=generate)
    if mode == "chat":
        monkeypatch.setattr(routes, "run_chat_stream", agent)
        response = client.post("/api/chat/stream", json={"query": "咨询问题"})
        agent.assert_called_once_with("咨询问题", [])
    else:
        monkeypatch.setattr(routes, "run_contract_analysis_stream", agent)
        response = client.post(
            "/api/analyze_contract/stream",
            files={"file": ("合同.txt", "合同原文".encode())},
        )
        agent.assert_called_once_with("合同原文")

    assert response.status_code == 200
    assert _read_events(response) == events


@pytest.mark.parametrize("mode", ["chat", "contract"])
def test_stream_failure_emits_error_event_after_existing_tokens(client, monkeypatch, mode):
    """已开始的流使用错误帧报告失败，不能把错误吞掉或伪装成正常完成。"""

    async def generate(*args):
        yield {"type": "token", "content": "已有内容"}
        raise RuntimeError("生成中断")

    if mode == "chat":
        monkeypatch.setattr(routes, "run_chat_stream", generate)
        response = client.post("/api/chat/stream", json={"query": "咨询问题"})
    else:
        monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
        response = client.post(
            "/api/analyze_contract/stream",
            files={"file": ("合同.txt", b"contract")},
        )

    assert response.status_code == 200
    assert _read_events(response) == [
        {"type": "token", "content": "已有内容"},
        {"type": "error", "message": "生成中断"},
    ]
