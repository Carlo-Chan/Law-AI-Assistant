"""用户消息定点编辑：校验归属和版本，不重建历史或改写报告输入。"""

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
            {"role": "user", "content": "上传合同，请检查错别字", "file_name": "原合同.txt"},
            {
                "role": "assistant",
                "content": "原合同报告",
                "contract_data": {
                    "raw_text": "甲方应退还押金。",
                    "chat_reply": "原合同报告",
                    "risk_points": [],
                    "instruction": "检查错别字",
                },
                "thinking_chain": [{"type": "tool", "label": "search_laws"}],
            },
            {"role": "user", "content": "后续问题"},
            {"role": "assistant", "content": "后续回复"},
        ],
    )
    return history_store.get_conversation(conv_id)


def edit(client, conv_id, message, content="修正后的问题", **payload):
    return client.patch(
        f"/api/conversations/{conv_id}/messages/{message['id']}",
        json={"expected_revision": message["revision"], "content": content, **payload},
    )


@pytest.mark.parametrize("index", [0, 2])
def test_edit_only_target_user_and_keep_other_rows_unchanged(client, history_store, stored, index):
    other_id = history_store.create_conversation()["id"]
    history_store.add_message(other_id, "user", "其他会话")
    other_before = history_store.get_conversation(other_id)
    target = stored["messages"][index]
    raw_before = history_store.get_message(stored["id"], target["id"])
    response = edit(client, stored["id"], target)
    assert response.status_code == 200
    after = history_store.get_conversation(stored["id"])
    changed = after["messages"][index]
    assert response.json()["data"] == {
        "message_id": target["id"],
        "revision": changed["revision"],
        "content": "修正后的问题",
        "saved": True,
    }
    assert changed == {**target, "content": "修正后的问题", "revision": changed["revision"]}
    assert changed["revision"] != target["revision"]
    assert after["messages"][:index] == stored["messages"][:index]
    assert after["messages"][index + 1 :] == stored["messages"][index + 1 :]
    assert after["title"] == stored["title"]
    assert after["created_at"] == stored["created_at"]
    assert history_store.get_message(stored["id"], target["id"]) == {
        **raw_before,
        "content": "修正后的问题",
    }
    assert history_store.get_conversation(other_id) == other_before


@pytest.mark.parametrize("content", ["", " \n多行中文和 emoji 😀\n\t ", "上传合同，请检查错别字"])
def test_content_is_saved_verbatim_including_empty_or_unchanged(
    client, history_store, stored, content
):
    target = stored["messages"][0]
    response = edit(client, stored["id"], target, content)
    assert response.status_code == 200
    saved = history_store.get_conversation(stored["id"])["messages"]
    assert saved[0]["content"] == content
    assert saved[0]["id"] == target["id"]
    assert saved[1:] == stored["messages"][1:]
    if content == target["content"]:
        assert response.json()["data"]["revision"] == target["revision"]


@pytest.mark.parametrize("change", ["content", "contract_data", "thinking_chain"])
def test_stale_revision_never_overwrites_changed_target(client, history_store, stored, change):
    target = stored["messages"][0]
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn, conn:
        conn.execute(
            f"UPDATE messages SET {change}=? WHERE id=?", (json.dumps("已变更"), target["id"])
        )
    before = history_store.get_conversation(stored["id"])
    response = edit(client, stored["id"], target)
    assert response.status_code == 409
    assert response.json()["code"] == "message_changed"
    assert history_store.get_conversation(stored["id"]) == before


def test_assistant_report_cannot_be_edited_by_user_message_endpoint(client, history_store, stored):
    response = edit(client, stored["id"], stored["messages"][1])
    assert response.status_code == 400
    assert response.json()["code"] == "message_not_editable"
    assert history_store.get_conversation(stored["id"]) == stored


@pytest.mark.parametrize(
    "kind", ["foreign", "missing-message", "missing-conversation", "deleted-message"]
)
def test_missing_or_wrong_owner_does_not_change_other_messages(client, history_store, stored, kind):
    target = stored["messages"][0]
    conv_id = stored["id"]
    if kind == "foreign":
        conv_id = history_store.create_conversation()["id"]
        history_store.add_message(conv_id, "user", "其他会话")
    elif kind == "missing-message":
        target = {**target, "id": 999999}
    elif kind == "missing-conversation":
        conv_id = "不存在的会话"
    else:
        history_store.delete_message(conv_id, target["id"], target["revision"])
    original_before = history_store.get_conversation(stored["id"])
    owner_before = history_store.get_conversation(conv_id)
    assert edit(client, conv_id, target).status_code == 404
    assert history_store.get_conversation(stored["id"]) == original_before
    assert history_store.get_conversation(conv_id) == owner_before


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"expected_revision": "a" * 64},
        {"content": "缺少版本"},
        {"expected_revision": "bad", "content": "问题"},
        {"expected_revision": None, "content": "问题"},
        {"expected_revision": "a" * 64, "content": None},
        {"expected_revision": "a" * 64, "content": 123},
    ],
)
def test_invalid_payload_does_not_write(client, history_store, stored, payload):
    response = client.patch(
        f"/api/conversations/{stored['id']}/messages/{stored['messages'][0]['id']}",
        json=payload,
    )
    assert response.status_code == 422
    assert history_store.get_conversation(stored["id"]) == stored


@pytest.mark.parametrize("field", ["role", "file_name", "contract_data", "thinking_chain"])
def test_extra_metadata_fields_are_rejected_not_silently_ignored(
    client, history_store, stored, field
):
    response = edit(client, stored["id"], stored["messages"][0], **{field: "不应修改"})
    assert response.status_code == 422
    assert history_store.get_conversation(stored["id"]) == stored


@pytest.mark.parametrize("message_id", [0, -1])
def test_non_positive_message_id_is_rejected(client, history_store, stored, message_id):
    assert (
        edit(client, stored["id"], {**stored["messages"][0], "id": message_id}).status_code == 422
    )
    assert history_store.get_conversation(stored["id"]) == stored


def test_storage_failure_rolls_back_content_and_conversation_time(client, history_store, stored):
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn, conn:
        conn.execute("""CREATE TRIGGER reject_message_edit BEFORE UPDATE OF content ON messages
            BEGIN SELECT RAISE(ABORT, 'private-storage-detail'); END""")
    response = edit(client, stored["id"], stored["messages"][0])
    assert response.status_code == 500
    assert "private-storage-detail" not in response.text
    assert history_store.get_conversation(stored["id"]) == stored


def test_append_after_snapshot_survives_edit(client, history_store, stored):
    history_store.add_messages(
        stored["id"],
        [
            {"role": "user", "content": "并发问题"},
            {"role": "assistant", "content": "并发回复"},
        ],
    )
    appended = history_store.get_conversation(stored["id"])["messages"][4:]
    assert edit(client, stored["id"], stored["messages"][0]).status_code == 200
    after = history_store.get_conversation(stored["id"])["messages"]
    assert len(after) == 6
    assert after[1:4] == stored["messages"][1:]
    assert after[4:] == appended


def test_reusing_old_revision_cannot_overwrite_first_edit(client, history_store, stored):
    target = stored["messages"][0]
    assert edit(client, stored["id"], target, "第一次修正").status_code == 200
    assert edit(client, stored["id"], target, "迟到的修正").status_code == 409
    assert history_store.get_conversation(stored["id"])["messages"][0]["content"] == "第一次修正"


def test_edit_does_not_run_model_or_parse_attachment(client, history_store, stored, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("编辑展示文字不能调用模型或重新解析附件")

    for name in (
        "run_chat",
        "run_chat_stream",
        "run_contract_analysis",
        "run_contract_analysis_stream",
    ):
        monkeypatch.setattr(routes, name, forbidden)
    monkeypatch.setattr(routes.DocumentParser, "parse", forbidden)
    assert edit(client, stored["id"], stored["messages"][0]).status_code == 200
    assert history_store.get_conversation(stored["id"])["messages"][1:] == stored["messages"][1:]


def test_user_edit_during_contract_regeneration_preserves_original_review_input(
    client, history_store, stored, monkeypatch
):
    """用户气泡的展示修改与已保存的审查输入分离，不取消报告的合法重跑。"""
    user, report = stored["messages"][:2]
    data = json.loads(report["contract_data"])

    async def generate(raw_text, instruction=""):
        assert raw_text == data["raw_text"]
        assert instruction == data["instruction"]
        yield {"type": "thinking", "label": "search_laws"}
        history_store.edit_user_message(
            stored["id"], user["id"], user["revision"], "只修正展示错别字"
        )
        yield {"type": "done", "raw_text": raw_text, "chat_reply": "新报告", "risk_points": []}

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    response = client.post(
        f"/api/conversations/{stored['id']}/messages/{report['id']}/regenerate_contract/stream",
        json={"expected_revision": report["revision"]},
    )
    assert response.status_code == 200
    events = [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert events[-1]["saved"] is True
    after = history_store.get_conversation(stored["id"])["messages"]
    assert after[0]["content"] == "只修正展示错别字"
    assert after[0]["file_name"] == user["file_name"]
    assert after[1]["id"] == report["id"]
    assert after[1]["content"] == "新报告"
    assert json.loads(after[1]["contract_data"])["instruction"] == data["instruction"]
    assert after[2:] == stored["messages"][2:]


def test_same_revision_concurrent_edits_only_commit_one(history_store):
    """真实两线程竞争 SQLite 写锁，不能让两个旧版本请求都覆盖成功。"""
    for _ in range(5):
        conv_id = history_store.create_conversation()["id"]
        history_store.add_message(conv_id, "user", "原问题")
        target = history_store.get_conversation(conv_id)["messages"][0]
        start = Barrier(2)

        def update(content, conv_id=conv_id, target=target, start=start):
            start.wait(timeout=10)
            try:
                return history_store.edit_user_message(
                    conv_id, target["id"], target["revision"], content
                )
            except PublicError as error:
                assert error.info.code == "message_changed"
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(update, "第一次修正")
            second = pool.submit(update, "第二次修正")
            results = [first.result(timeout=15), second.result(timeout=15)]
        successful = [result for result in results if result]
        assert len(successful) == 1
        saved = history_store.get_conversation(conv_id)["messages"]
        assert len(saved) == 1
        assert saved[0]["content"] == successful[0]["content"]
        assert saved[0]["revision"] == successful[0]["revision"]


def test_edit_and_delete_same_revision_never_restore_deleted_message(history_store):
    for _ in range(5):
        conv_id = history_store.create_conversation()["id"]
        history_store.add_messages(
            conv_id,
            [
                {"role": "user", "content": "原问题"},
                {"role": "assistant", "content": "保留回复"},
            ],
        )
        target = history_store.get_conversation(conv_id)["messages"][0]
        start = Barrier(2)

        def mutate(kind, conv_id=conv_id, target=target, start=start):
            start.wait(timeout=10)
            try:
                if kind == "edit":
                    history_store.edit_user_message(
                        conv_id, target["id"], target["revision"], "修改问题"
                    )
                else:
                    history_store.delete_message(conv_id, target["id"], target["revision"])
                return True
            except PublicError as error:
                assert error.info.status_code in (404, 409)
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            updating = pool.submit(mutate, "edit")
            deleting = pool.submit(mutate, "delete")
            edited, removed = updating.result(timeout=15), deleting.result(timeout=15)
        assert edited != removed
        saved = history_store.get_conversation(conv_id)["messages"]
        assert saved[-1]["content"] == "保留回复"
        if removed:
            assert len(saved) == 1
        else:
            assert len(saved) == 2
            assert saved[0]["content"] == "修改问题"
