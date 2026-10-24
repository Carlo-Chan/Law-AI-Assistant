"""合同原文重跑回归：生成失败不删历史，成功只原子替换目标报告。"""

import json
import sqlite3
from contextlib import closing
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.main import app
from app.services import history
from app.services.contract_regeneration import regenerate_report

RAW_TEXT = "第一条：租金按月支付，甲方应按时退还押金。"
NEW_REPORT = {
    "raw_text": RAW_TEXT,
    "chat_reply": "新的完整审查报告",
    "risk_points": [{"quote": "退还押金", "level": "low", "bubble_text": "建议明确退还日期。"}],
}


@pytest.fixture
def client(history_store):
    with TestClient(app) as instance:
        yield instance


@pytest.fixture
def stored_report(client):
    """目标报告后面仍有一轮问答，防止重跑误清空后续历史。"""
    conv_id = client.post("/api/conversations").json()["data"]["id"]
    history.add_messages(
        conv_id,
        [
            {"role": "user", "content": "请审查合同", "file_name": "原合同.pdf"},
            {
                "role": "assistant",
                "content": "旧审查报告",
                "contract_data": {
                    "raw_text": RAW_TEXT,
                    "chat_reply": "旧审查报告",
                    "risk_points": [],
                },
                "thinking_chain": [{"type": "tool", "label": "旧工具"}],
            },
            {"role": "user", "content": "后续问题"},
            {"role": "assistant", "content": "后续回复"},
        ],
    )
    detail = client.get(f"/api/conversations/{conv_id}").json()["data"]
    target = detail["messages"][1]
    return {
        "conv_id": conv_id,
        "target": target,
        "before": detail,
        "url": f"/api/conversations/{conv_id}/messages/{target['id']}/regenerate_contract/stream",
        "payload": {"expected_revision": target["revision"]},
    }


def _events(response):
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def _detail(client, stored_report):
    return client.get(f"/api/conversations/{stored_report['conv_id']}").json()["data"]


def test_regeneration_commits_target_only_after_complete_result(client, stored_report, monkeypatch):
    """直接读取保存的原文，不重新解析附件，完成帧必须晚于数据库提交。"""
    parser = Mock(side_effect=AssertionError("重跑不应调用文档解析器"))
    monkeypatch.setattr(routes.DocumentParser, "parse", parser)
    before_row = history.get_message(stored_report["conv_id"], stored_report["target"]["id"])
    other_id = client.post("/api/conversations").json()["data"]["id"]
    history.add_message(other_id, "user", "其他会话")
    other_before = history.get_conversation(other_id)

    async def generate(raw_text):
        assert raw_text == RAW_TEXT
        yield {"type": "thinking", "label": "search_laws"}
        yield {"type": "thinking_reasoning_token", "content": "核对"}
        yield {"type": "thinking_reasoning_token", "content": "条款"}
        yield {"type": "tool_result_chunk", "tool": "search_laws", "first": True, "content": "法条"}
        yield {
            "type": "tool_result_chunk",
            "tool": "search_laws",
            "first": False,
            "content": "依据",
        }
        yield {"type": "token", "content": "尚未完成的片段"}
        assert history.get_conversation(stored_report["conv_id"]) == stored_report["before"]
        yield {"type": "done", **NEW_REPORT}
        raise AssertionError("结束帧后的内容不应继续消费")

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    events = _events(client.post(stored_report["url"], json=stored_report["payload"]))
    done = events[-1]
    assert done["type"] == "done"
    assert done["saved"] is True
    assert done["message_id"] == stored_report["target"]["id"]
    assert done["thinking_chain"] == [
        {"type": "tool", "label": "search_laws"},
        {"type": "reasoning", "label": "核对条款"},
        {"type": "done", "label": "search_laws 完成", "snippet": "法条依据"},
    ]
    after = _detail(client, stored_report)
    assert len(after["messages"]) == 4
    for index in (0, 2, 3):
        assert after["messages"][index] == stored_report["before"]["messages"][index]
    updated = after["messages"][1]
    assert updated["id"] == stored_report["target"]["id"]
    assert updated["content"] == NEW_REPORT["chat_reply"]
    assert json.loads(updated["contract_data"]) == NEW_REPORT
    assert updated["revision"] == done["revision"] != stored_report["target"]["revision"]
    assert updated["thinking_chain"] == done["thinking_chain"]
    assert (
        history.get_message(stored_report["conv_id"], updated["id"])["created_at"]
        == before_row["created_at"]
    )
    assert history.get_conversation(other_id) == other_before
    parser.assert_not_called()


@pytest.mark.parametrize("failure", ["exception", "error_frame", "truncated"])
def test_failure_keeps_report_and_all_history(client, stored_report, monkeypatch, failure):
    """异常、模型错误帧和缺少完成帧均不能提交半份报告。"""

    async def generate(raw_text):
        yield {"type": "token", "content": "只有部分内容"}
        if failure == "exception":
            raise httpx.ReadTimeout("sk-private-key 敏感原文 内部路径")
        if failure == "error_frame":
            yield {"type": "error", "message": "模型服务暂不可用", "code": "upstream_error"}

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    events = _events(client.post(stored_report["url"], json=stored_report["payload"]))
    assert events[-1]["type"] == "error"
    assert sum(event["type"] == "error" for event in events) == 1
    assert all(event["type"] != "done" for event in events)
    assert "sk-private-key" not in json.dumps(events)
    assert _detail(client, stored_report) == stored_report["before"]


@pytest.mark.parametrize(
    "result",
    [
        {**NEW_REPORT, "chat_reply": "   "},
        {**NEW_REPORT, "raw_text": "另一份合同"},
        {**NEW_REPORT, "risk_points": "格式错误"},
        {"chat_reply": "缺少必要字段"},
    ],
)
def test_invalid_result_is_not_saved(client, stored_report, monkeypatch, result):
    """结束帧本身也必须结构完整，且仍对应同一份原文。"""

    async def generate(raw_text):
        yield {"type": "done", **result}

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    events = _events(client.post(stored_report["url"], json=stored_report["payload"]))
    assert events == [
        {
            "type": "error",
            "code": "invalid_report",
            "message": "审查报告格式异常，请重试；若持续失败，请联系管理员。",
        }
    ]
    assert _detail(client, stored_report) == stored_report["before"]


@pytest.mark.parametrize("operation", ["edit", "rebuild", "delete", "another_result"])
def test_concurrent_change_is_not_overwritten(client, stored_report, monkeypatch, operation):
    """模型等待期间目标发生变更时，旧请求不能覆盖较新的编辑或重跑结果。"""
    expected = None

    async def generate(raw_text):
        nonlocal expected
        if operation == "edit":
            with closing(sqlite3.connect(history.DB_PATH)) as connection, connection:
                connection.execute(
                    "UPDATE messages SET content='用户修改后的报告' WHERE id=?",
                    (stored_report["target"]["id"],),
                )
        elif operation == "rebuild":
            history.rebuild_messages(
                stored_report["conv_id"], [{"role": "user", "content": "重新编辑后的记录"}]
            )
        elif operation == "delete":
            history.delete_conversation(stored_report["conv_id"])
        else:
            original = history.get_message(stored_report["conv_id"], stored_report["target"]["id"])
            history.replace_contract_report(
                original, {**NEW_REPORT, "chat_reply": "另一次重跑的新报告"}, []
            )
        expected = history.get_conversation(stored_report["conv_id"])
        yield {"type": "done", **NEW_REPORT}

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    events = _events(client.post(stored_report["url"], json=stored_report["payload"]))
    assert events[-1]["code"] == "report_changed"
    assert all(event["type"] != "done" for event in events)
    assert history.get_conversation(stored_report["conv_id"]) == expected


def test_storage_failure_rolls_back_report_update(client, stored_report, monkeypatch):
    """在更新会话时间时故意失败，验证已经执行的报告更新也整体回滚。"""
    with closing(sqlite3.connect(history.DB_PATH)) as connection, connection:
        connection.execute("""CREATE TRIGGER reject_regeneration_timestamp
            BEFORE UPDATE OF updated_at ON conversations BEGIN
            SELECT RAISE(ABORT, 'sk-private-storage-error'); END""")

    async def generate(raw_text):
        yield {"type": "done", **NEW_REPORT}

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    events = _events(client.post(stored_report["url"], json=stored_report["payload"]))
    assert events[-1]["type"] == "error"
    assert "sk-private" not in json.dumps(events)
    assert _detail(client, stored_report) == stored_report["before"]


@pytest.mark.parametrize(
    "stored_data", [None, "invalid-json", "[]", '{"raw_text":""}', '{"raw_text":10}']
)
def test_missing_source_is_rejected_before_model_call(
    client, stored_report, monkeypatch, stored_data
):
    """缺少原文的旧记录才提示补传，不能猜测或借用其他报告的合同。"""
    with closing(sqlite3.connect(history.DB_PATH)) as connection, connection:
        connection.execute(
            "UPDATE messages SET contract_data=? WHERE id=?",
            (stored_data, stored_report["target"]["id"]),
        )
    before = _detail(client, stored_report)
    agent = Mock()
    monkeypatch.setattr(routes, "run_contract_analysis_stream", agent)
    revision = before["messages"][1]["revision"]
    response = client.post(stored_report["url"], json={"expected_revision": revision})
    assert response.status_code == 400
    assert response.json()["code"] == "contract_source_missing"
    assert _detail(client, stored_report) == before
    agent.assert_not_called()


@pytest.mark.parametrize("target", ["foreign", "user", "missing", "stale"])
def test_target_and_revision_checked_before_model_call(client, stored_report, monkeypatch, target):
    """目标必须属于当前会话，且是客户端正在查看的报告版本。"""
    agent = Mock()
    monkeypatch.setattr(routes, "run_contract_analysis_stream", agent)
    url = stored_report["url"]
    payload = stored_report["payload"]
    if target == "foreign":
        url = url.replace(stored_report["conv_id"], "other-conversation")
    elif target == "user":
        url = url.replace(
            f"/messages/{stored_report['target']['id']}/",
            f"/messages/{stored_report['before']['messages'][0]['id']}/",
        )
    elif target == "missing":
        url = url.replace(f"/messages/{stored_report['target']['id']}/", "/messages/999999/")
    else:
        payload = {"expected_revision": "0" * 64}
    response = client.post(url, json=payload)
    assert response.status_code == (409 if target == "stale" else 404)
    assert _detail(client, stored_report) == stored_report["before"]
    agent.assert_not_called()


@pytest.mark.parametrize("payload", [{}, {"expected_revision": "bad"}, {"expected_revision": None}])
def test_invalid_regeneration_request_keeps_history(client, stored_report, monkeypatch, payload):
    agent = Mock()
    monkeypatch.setattr(routes, "run_contract_analysis_stream", agent)
    response = client.post(stored_report["url"], json=payload)
    assert response.status_code == 422
    assert _detail(client, stored_report) == stored_report["before"]
    agent.assert_not_called()


@pytest.mark.asyncio
async def test_cancel_before_completion_closes_producer_without_saving(stored_report):
    """客户端在完整结果生成前停止时，旧报告保留，并释放事件生成器。"""
    closed = False

    async def generate():
        nonlocal closed
        try:
            yield {"type": "token", "content": "生成中"}
            yield {"type": "done", **NEW_REPORT}
        finally:
            closed = True

    original = history.get_message(stored_report["conv_id"], stored_report["target"]["id"])
    stream = regenerate_report(original, generate(), lambda event: NEW_REPORT)
    assert (await anext(stream))["type"] == "token"
    await stream.aclose()
    assert closed
    assert history.get_conversation(stored_report["conv_id"]) == stored_report["before"]


@pytest.mark.asyncio
async def test_route_close_releases_nested_stream(stored_report, monkeypatch):
    """HTTP 流被关闭时同步关闭内层生成器，不能留后台任务继续提交。"""
    closed = False

    async def generate(raw_text):
        nonlocal closed
        try:
            yield {"type": "token", "content": "生成中"}
            yield {"type": "done", **NEW_REPORT}
        finally:
            closed = True

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    response = await routes.regenerate_contract(
        stored_report["conv_id"],
        stored_report["target"]["id"],
        routes.RegenerateContractRequest(**stored_report["payload"]),
    )
    assert "生成中" in await anext(response.body_iterator)
    await response.body_iterator.aclose()
    assert closed
    assert history.get_conversation(stored_report["conv_id"]) == stored_report["before"]
