"""穿过真实 API、编排和正文提取边界，外部 Agent 使用离线替身。"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, AIMessageChunk

from app.agent import chain
from app.main import app

RAW_TEXT = "押金3000元。"
REPLY = "第一段\n\n第二段，建议明确退还条件。"
HIDDEN = "不应出现在接口或错误提示中的供应商元数据"


@pytest.fixture
def client(history_store):
    with TestClient(app) as instance:
        yield instance


@pytest.mark.parametrize("mode", ["chat", "contract"])
@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("valid", [False, True])
def test_api_preserves_text_protocol_and_uses_fixed_errors_for_missing_body(
    client, monkeypatch, mode, streaming, valid
):
    """仅正文块能够到达公开接口，推理块不能伪装成普通回复或合同 JSON。"""
    text = (
        REPLY
        if mode == "chat"
        else json.dumps(
            {
                "chat_reply": REPLY,
                "risk_points": [
                    {"key_phrase": "押金3000元", "level": "low", "bubble_text": "建议明确期限。"}
                ],
            },
            ensure_ascii=False,
        )
    )
    content = [{"type": "reasoning", "reasoning": HIDDEN, "text": text}]
    if valid:
        content.append({"type": "text", "text": text, "annotations": [{"text": HIDDEN}]})

    async def generate(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {
                "chunk": AIMessageChunk(
                    content=content, additional_kwargs={"reasoning_content": HIDDEN}
                )
            },
        }

    monkeypatch.setattr(
        chain,
        mode + "_agent",
        SimpleNamespace(
            ainvoke=AsyncMock(return_value={"messages": [AIMessage(content=content)]}),
            astream_events=generate,
        ),
    )
    monkeypatch.setattr(chain.asyncio, "sleep", AsyncMock())
    endpoint = "/api/chat" if mode == "chat" else "/api/analyze_contract"
    arguments = (
        {"json": {"query": "合成问题"}}
        if mode == "chat"
        else {
            "files": {"file": ("合成合同.txt", RAW_TEXT.encode(), "text/plain")},
        }
    )
    response = client.post(endpoint + ("/stream" if streaming else ""), **arguments)
    assert HIDDEN not in response.text
    if streaming:
        assert response.status_code == 200
        events = [
            json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
        ]
        if valid:
            assert (
                "".join(event["content"] for event in events if event["type"] == "token") == REPLY
            )
            assert events[-1]["type"] == "done"
        else:
            assert len(events) == 1
            assert events[0]["type"] == "error"
            assert events[0]["code"] == (
                "invalid_model_reply" if mode == "chat" else "invalid_report"
            )
    elif valid:
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["reply" if mode == "chat" else "chat_reply"] == REPLY
    else:
        assert response.status_code == 502
        assert response.json()["code"] == (
            "invalid_model_reply" if mode == "chat" else "invalid_report"
        )
    assert client.get("/api/conversations").json()["data"] == []
