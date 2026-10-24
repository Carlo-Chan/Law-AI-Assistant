"""普通咨询重新生成：只替换目标回复，不删除问题、后续轮次或其他会话。"""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.core.errors import PublicError
from app.main import app
from app.services import history
from app.services.chat_regeneration import load_chat_source


@pytest.fixture
def client(history_store):
    with TestClient(app) as instance:
        yield instance


@pytest.fixture
def stored(history_store):
    conv_id = history_store.create_conversation("保留原标题")["id"]
    history_store.add_messages(
        conv_id,
        [
            {"role": "user", "content": "前一轮问题"},
            {"role": "assistant", "content": "前一轮回答"},
            {"role": "user", "content": "当前问题"},
            {
                "role": "assistant",
                "content": "原回复",
                "thinking_chain": [{"type": "tool", "label": "旧工具"}],
            },
            {"role": "user", "content": "后续问题"},
            {"role": "assistant", "content": "后续回答"},
        ],
    )
    detail = history_store.get_conversation(conv_id)
    target = detail["messages"][3]
    return {
        "id": conv_id,
        "target": target,
        "before": detail,
        "url": f"/api/conversations/{conv_id}/messages/{target['id']}/regenerate_chat/stream",
        "payload": {"expected_revision": target["revision"]},
    }


def events(response):
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def test_success_replaces_only_target_after_committing(client, stored, monkeypatch):
    other_id = history.create_conversation()["id"]
    history.add_message(other_id, "user", "其他会话")
    other_before = history.get_conversation(other_id)

    async def generate(query, context):
        assert query == "当前问题"
        assert context == [
            {"role": "user", "content": "前一轮问题"},
            {"role": "assistant", "content": "前一轮回答"},
        ]
        yield {"type": "thinking", "label": "search_laws"}
        yield {"type": "token", "content": "新的"}
        assert history.get_conversation(stored["id"])["messages"][3]["content"] == "原回复"
        yield {"type": "token", "content": "完整回复"}
        yield {"type": "done"}

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    result = events(client.post(stored["url"], json=stored["payload"]))
    assert result[-1]["type"] == "done"
    assert result[-1]["saved"] is True
    assert result[-1]["message_id"] == stored["target"]["id"]
    assert result[-1]["chat_reply"] == "新的完整回复"
    after = history.get_conversation(stored["id"])
    assert after["messages"][:3] == stored["before"]["messages"][:3]
    assert after["messages"][4:] == stored["before"]["messages"][4:]
    assert after["messages"][3]["revision"] == result[-1]["revision"]
    assert after["title"] == stored["before"]["title"]
    assert history.get_conversation(other_id) == other_before
    assert result[-1]["source_message_id"] == stored["before"]["messages"][2]["id"]
    assert result[-1]["query"] == "当前问题"


@pytest.mark.parametrize("kind", ["foreign", "missing", "user", "stale"])
def test_invalid_target_does_not_start_model(client, stored, monkeypatch, kind):
    def forbidden(*args, **kwargs):
        raise AssertionError("校验失败不能调用模型")

    monkeypatch.setattr(routes, "run_chat_stream", forbidden)
    url = stored["url"]
    payload = stored["payload"]
    if kind == "foreign":
        url = url.replace(stored["id"], "其他会话")
    elif kind == "missing":
        url = url.replace(f"/{stored['target']['id']}/", "/999999/")
    elif kind == "user":
        url = url.replace(
            f"/{stored['target']['id']}/", f"/{stored['before']['messages'][2]['id']}/"
        )
    else:
        payload = {"expected_revision": "a" * 64}
    response = client.post(url, json=payload)
    assert response.status_code == (409 if kind == "stale" else 404)
    assert history.get_conversation(stored["id"]) == stored["before"]


@pytest.mark.parametrize("kind", ["contract", "file", "missing-user", "empty-user"])
def test_missing_or_contract_source_is_rejected(client, stored, monkeypatch, kind):
    target_id = stored["target"]["id"]
    user_id = stored["before"]["messages"][2]["id"]
    with closing(sqlite3.connect(history.DB_PATH)) as conn, conn:
        if kind == "contract":
            conn.execute(
                "UPDATE messages SET contract_data=? WHERE id=?",
                (json.dumps({"raw_text": "合同"}), target_id),
            )
        elif kind == "file":
            conn.execute("UPDATE messages SET file_name='合同.txt' WHERE id=?", (user_id,))
        elif kind == "missing-user":
            conn.execute("DELETE FROM messages WHERE id=?", (user_id,))
        else:
            conn.execute("UPDATE messages SET content='  ' WHERE id=?", (user_id,))
    before = history.get_conversation(stored["id"])
    target = history.get_message(stored["id"], target_id)
    monkeypatch.setattr(routes, "run_chat_stream", lambda *args: pytest.fail("不能调用模型"))
    response = client.post(
        stored["url"], json={"expected_revision": history.message_revision(target)}
    )
    assert response.status_code == 400
    assert response.json()["code"] == (
        "reply_not_supported" if kind in ("contract", "file") else "reply_source_missing"
    )
    assert history.get_conversation(stored["id"]) == before


@pytest.mark.parametrize("payload", [{}, {"expected_revision": "bad"}, {"expected_revision": None}])
def test_invalid_revision_does_not_write(client, stored, payload):
    assert client.post(stored["url"], json=payload).status_code == 422
    assert history.get_conversation(stored["id"]) == stored["before"]


@pytest.mark.parametrize("message_id", [0, -1])
def test_non_positive_id_is_rejected(client, stored, message_id):
    url = stored["url"].replace(f"/{stored['target']['id']}/", f"/{message_id}/")
    assert client.post(url, json=stored["payload"]).status_code == 422


@pytest.mark.parametrize(
    "failure", ["raise", "error", "eof", "empty", "blank", "bad-token", "aborted"]
)
def test_incomplete_or_failed_generation_keeps_original(client, stored, monkeypatch, failure):
    async def generate(*args):
        if failure == "empty":
            yield {"type": "done"}
            return
        if failure == "bad-token":
            yield {"type": "token", "content": None}
            return
        yield {"type": "token", "content": "  " if failure == "blank" else "部分新回复"}
        if failure == "raise":
            raise ConnectionError("sk-private-detail")
        if failure == "error":
            yield {"type": "error", "message": "服务暂时不可用。"}
        elif failure != "eof":
            yield {"type": "done", "aborted": failure == "aborted"}

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    result = events(client.post(stored["url"], json=stored["payload"]))
    assert result[-1]["type"] == "error"
    assert "sk-private" not in json.dumps(result)
    assert all(event["type"] != "done" for event in result)
    assert history.get_conversation(stored["id"]) == stored["before"]


@pytest.mark.parametrize(
    "operation",
    [
        "source",
        "earlier",
        "delete-source",
        "delete-target",
        "delete-conversation",
        "rebuild",
        "another-result",
    ],
)
def test_changed_context_or_target_cannot_be_overwritten(client, stored, monkeypatch, operation):
    expected = None

    async def generate(*args):
        nonlocal expected
        if operation in ("source", "earlier"):
            user = stored["before"]["messages"][2 if operation == "source" else 0]
            history.edit_user_message(stored["id"], user["id"], user["revision"], "新版本的问题")
        elif operation in ("delete-source", "delete-target"):
            target = stored["before"]["messages"][2 if operation == "delete-source" else 3]
            history.delete_message(stored["id"], target["id"], target["revision"])
        elif operation == "delete-conversation":
            history.delete_conversation(stored["id"])
        elif operation == "rebuild":
            history.rebuild_messages(stored["id"], [{"role": "user", "content": "重建后的消息"}])
        else:
            prefix, _, _ = load_chat_source(
                stored["id"], stored["target"]["id"], stored["target"]["revision"]
            )
            history.replace_chat_reply(prefix, "另一次生成的回复", [])
        expected = history.get_conversation(stored["id"])
        yield {"type": "token", "content": "不能覆盖的新回复"}
        yield {"type": "done"}

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    result = events(client.post(stored["url"], json=stored["payload"]))
    assert result[-1]["code"] == "reply_changed"
    assert history.get_conversation(stored["id"]) == expected


def test_later_append_and_title_rename_survive_regeneration(client, stored, monkeypatch):
    appended = None

    async def generate(*args):
        nonlocal appended
        history.add_messages(
            stored["id"],
            [{"role": "user", "content": "并发问题"}, {"role": "assistant", "content": "并发回复"}],
        )
        history.update_title(stored["id"], "新标题")
        appended = history.get_conversation(stored["id"])["messages"][4:]
        yield {"type": "token", "content": "新回复"}
        yield {"type": "done"}

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    result = events(client.post(stored["url"], json=stored["payload"]))
    assert result[-1]["saved"] is True
    after = history.get_conversation(stored["id"])
    assert after["title"] == "新标题"
    assert after["messages"][4:] == appended


def test_server_uses_current_saved_question_not_client_supplied_history(
    client, stored, monkeypatch
):
    user = stored["before"]["messages"][2]
    history.edit_user_message(stored["id"], user["id"], user["revision"], "已保存的新问题")

    async def generate(query, context):
        assert query == "已保存的新问题"
        assert len(context) == 2
        yield {"type": "token", "content": "新回复"}
        yield {"type": "done"}

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    result = events(
        client.post(stored["url"], json={**stored["payload"], "query": "伪造问题", "history": []})
    )
    assert result[-1]["query"] == "已保存的新问题"


def test_storage_failure_rolls_back_reply_and_timestamp(client, stored, monkeypatch):
    with closing(sqlite3.connect(history.DB_PATH)) as conn, conn:
        conn.execute("""CREATE TRIGGER reject_reply_update BEFORE UPDATE OF content ON messages
            BEGIN SELECT RAISE(ABORT, 'sk-private-storage-detail'); END""")

    async def generate(*args):
        yield {"type": "token", "content": "新回复"}
        yield {"type": "done"}

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    result = events(client.post(stored["url"], json=stored["payload"]))
    assert result[-1]["type"] == "error"
    assert "sk-private" not in json.dumps(result)
    assert history.get_conversation(stored["id"]) == stored["before"]


def test_tool_trace_is_saved_once_with_new_reply(client, stored, monkeypatch):
    async def generate(*args):
        for event in [
            {"type": "thinking_reasoning_token", "content": "核对"},
            {"type": "thinking_reasoning_token", "content": "法条"},
            {"type": "thinking", "label": "search_laws"},
            {"type": "tool_result_chunk", "tool": "search_laws", "first": True, "content": "依据"},
            {"type": "tool_result_chunk", "tool": "search_laws", "first": False, "content": "全文"},
            {"type": "tool_result_end", "tool": "search_laws"},
            {"type": "thinking_reasoning", "content": "整理结论"},
            {"type": "tool_result", "tool": "search_web", "output": "补充资料"},
            {"type": "token", "content": "新回复"},
            {"type": "done"},
            {"type": "done"},
        ]:
            yield event

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    result = events(client.post(stored["url"], json=stored["payload"]))
    assert sum(event["type"] == "done" for event in result) == 1
    expected = [
        {"type": "reasoning", "label": "核对法条"},
        {"type": "tool", "label": "search_laws"},
        {"type": "done", "label": "search_laws 完成", "snippet": "依据全文"},
        {"type": "reasoning", "label": "整理结论"},
        {"type": "done", "label": "search_web 完成", "snippet": "补充资料"},
    ]
    assert result[-1]["thinking_chain"] == expected
    assert history.get_conversation(stored["id"])["messages"][3]["thinking_chain"] == expected


@pytest.mark.asyncio
async def test_disconnect_closes_model_and_preserves_original(stored, monkeypatch):
    closed = False

    async def generate(*args):
        nonlocal closed
        try:
            yield {"type": "token", "content": "未完成的新回复"}
            yield {"type": "done"}
        finally:
            closed = True

    monkeypatch.setattr(routes, "run_chat_stream", generate)
    response = await routes.regenerate_chat(
        stored["id"], stored["target"]["id"], routes.RegenerateChatRequest(**stored["payload"])
    )
    await anext(response.body_iterator)
    await response.body_iterator.aclose()
    assert closed
    assert history.get_conversation(stored["id"]) == stored["before"]


def test_two_simultaneous_results_only_commit_one(stored):
    prefix, _, _ = load_chat_source(
        stored["id"], stored["target"]["id"], stored["target"]["revision"]
    )
    barrier = Barrier(2)

    def commit(content):
        barrier.wait(timeout=10)
        try:
            return history.replace_chat_reply(prefix, content, [])
        except PublicError as error:
            assert error.info.code == "reply_changed"
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.submit(commit, "新回复一"), pool.submit(commit, "新回复二")
        results = [first.result(timeout=15), second.result(timeout=15)]
    assert sum(result is not None for result in results) == 1
    after = history.get_conversation(stored["id"])["messages"]
    assert len(after) == 6
    assert after[3]["content"] in ("新回复一", "新回复二")


def test_deleted_source_cannot_rebind_reply_to_an_earlier_remaining_user(
    client, stored, monkeypatch
):
    """删掉中间的回答和源问题后，不把残留的更早问题冒认成当前回复的来源。"""
    for message in stored["before"]["messages"][1:3]:
        history.delete_message(stored["id"], message["id"], message["revision"])
    before = history.get_conversation(stored["id"])
    monkeypatch.setattr(routes, "run_chat_stream", lambda *args: pytest.fail("不能猜测问题来源"))
    response = client.post(stored["url"], json=stored["payload"])
    assert response.status_code == 400
    assert response.json()["code"] == "reply_source_missing"
    assert history.get_conversation(stored["id"]) == before
