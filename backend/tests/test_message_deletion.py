"""按稳定消息身份删除，不通过整段重建覆盖其他消息或并发结果。"""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from app.core.errors import PublicError
from app.main import app


@pytest.fixture
def client(history_store):
    with TestClient(app) as instance:
        yield instance


@pytest.fixture
def stored(history_store):
    conv_id = history_store.create_conversation("保留标题")["id"]
    history_store.add_messages(
        conv_id,
        [
            {"role": "user", "content": "请审查合同", "file_name": "原合同.txt"},
            {
                "role": "assistant",
                "content": "完整报告",
                "contract_data": {
                    "raw_text": "甲方应退还押金。",
                    "chat_reply": "完整报告",
                    "risk_points": [],
                    "instruction": "重点检查押金",
                },
                "thinking_chain": [{"type": "tool", "label": "search_laws"}],
            },
            {"role": "user", "content": "后续问题"},
            {"role": "assistant", "content": "后续回复"},
        ],
    )
    return history_store.get_conversation(conv_id)


def delete(client, conv_id, message, **payload):
    return client.request(
        "DELETE",
        f"/api/conversations/{conv_id}/messages/{message['id']}",
        json={"expected_revision": message["revision"], **payload},
    )


@pytest.mark.parametrize("index", [0, 1, 2, 3])
def test_delete_exact_message_preserves_remaining_id_revision_and_metadata(
    client, history_store, stored, index
):
    other_id = history_store.create_conversation()["id"]
    history_store.add_message(other_id, "user", "其他会话")
    other_before = history_store.get_conversation(other_id)
    response = delete(client, stored["id"], stored["messages"][index])
    assert response.status_code == 200
    assert response.json()["data"] == {
        "message_id": stored["messages"][index]["id"],
        "conversation_deleted": False,
    }
    after = history_store.get_conversation(stored["id"])
    assert after["messages"] == stored["messages"][:index] + stored["messages"][index + 1 :]
    assert after["title"] == stored["title"]
    assert after["created_at"] == stored["created_at"]
    assert history_store.get_conversation(other_id) == other_before


def test_delete_last_message_atomically_removes_empty_conversation(client, history_store):
    conv_id = history_store.create_conversation()["id"]
    history_store.add_message(conv_id, "assistant", "最后一条消息")
    target = history_store.get_conversation(conv_id)["messages"][0]
    response = delete(client, conv_id, target)
    assert response.status_code == 200
    assert response.json()["data"]["conversation_deleted"] is True
    assert history_store.get_conversation(conv_id) is None
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0


def test_last_saved_message_keeps_container_for_other_unsaved_messages(client, history_store):
    conv_id = history_store.create_conversation()["id"]
    history_store.add_message(conv_id, "assistant", "已保存的旧回复")
    target = history_store.get_conversation(conv_id)["messages"][0]
    response = delete(client, conv_id, target, preserve_empty_conversation=True)
    assert response.status_code == 200
    assert response.json()["data"]["conversation_deleted"] is False
    assert history_store.get_conversation(conv_id)["messages"] == []
    history_store.add_messages(
        conv_id,
        [
            {"role": "user", "content": "尚未保存的问题"},
            {"role": "assistant", "content": "稍后完成的回复"},
        ],
    )
    assert len(history_store.get_conversation(conv_id)["messages"]) == 2


@pytest.mark.parametrize("with_metadata", [False, True])
def test_save_receipts_match_committed_ids_roles_and_revisions(
    client, history_store, with_metadata
):
    conv_id = history_store.create_conversation()["id"]
    payload = {"user_content": "提问", "assistant_content": "完整回复"}
    if with_metadata:
        payload.update(
            {
                "file_name": "合同.txt",
                "contract_data": {"raw_text": "中文原文", "instruction": "审查重点"},
                "thinking_chain": [{"type": "tool", "label": "工具"}],
            }
        )
    response = client.post(f"/api/conversations/{conv_id}/messages", json=payload)
    assert response.status_code == 200
    saved = history_store.get_conversation(conv_id)["messages"]
    receipt = response.json()["data"]
    assert receipt["ok"] is True
    assert receipt["messages"] == [
        {field: message[field] for field in ("id", "role", "revision")} for message in saved
    ]
    response = delete(client, conv_id, {**saved[1], **receipt["messages"][1]})
    assert response.status_code == 200
    assert history_store.get_conversation(conv_id)["messages"] == saved[:1]


def test_failed_pair_insert_has_no_receipt_or_partial_message(client, history_store):
    conv_id = history_store.create_conversation()["id"]
    before = history_store.get_conversation(conv_id)
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn, conn:
        conn.execute("""CREATE TRIGGER reject_assistant_insert BEFORE INSERT ON messages
            WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'private-insert-detail'); END""")
    response = client.post(
        f"/api/conversations/{conv_id}/messages",
        json={
            "user_content": "问题",
            "assistant_content": "回复",
        },
    )
    assert response.status_code == 500
    assert "private-insert-detail" not in response.text
    assert "messages" not in response.json().get("data", {})
    assert history_store.get_conversation(conv_id) == before


@pytest.mark.parametrize("change", ["content", "contract_data", "thinking_chain"])
def test_stale_revision_cannot_delete_changed_target(client, history_store, stored, change):
    target = stored["messages"][1]
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn, conn:
        conn.execute(
            f"UPDATE messages SET {change}=? WHERE id=?", (json.dumps("已变更"), target["id"])
        )
    before = history_store.get_conversation(stored["id"])
    response = delete(client, stored["id"], target)
    assert response.status_code == 409
    assert response.json()["code"] == "message_changed"
    assert history_store.get_conversation(stored["id"]) == before


@pytest.mark.parametrize("target_kind", ["foreign", "missing", "deleted-conversation"])
def test_wrong_owner_or_missing_target_never_deletes_other_messages(
    client, history_store, stored, target_kind
):
    target = stored["messages"][1]
    conv_id = stored["id"]
    if target_kind == "foreign":
        conv_id = history_store.create_conversation()["id"]
        history_store.add_message(conv_id, "user", "其他会话的消息")
    elif target_kind == "missing":
        target = {**target, "id": 999999}
    else:
        conv_id = "deleted-conversation"
    before = history_store.get_conversation(conv_id)
    response = delete(client, conv_id, target)
    assert response.status_code == 404
    assert history_store.get_conversation(stored["id"]) == stored
    assert history_store.get_conversation(conv_id) == before


@pytest.mark.parametrize("payload", [{}, {"expected_revision": "bad"}, {"expected_revision": None}])
def test_invalid_revision_is_rejected_without_mutation(client, history_store, stored, payload):
    response = client.request(
        "DELETE",
        f"/api/conversations/{stored['id']}/messages/{stored['messages'][0]['id']}",
        json=payload,
    )
    assert response.status_code == 422
    assert history_store.get_conversation(stored["id"]) == stored


def test_duplicate_delete_does_not_target_next_message(client, history_store, stored):
    target = stored["messages"][1]
    assert delete(client, stored["id"], target).status_code == 200
    before = history_store.get_conversation(stored["id"])
    assert delete(client, stored["id"], target).status_code == 404
    assert history_store.get_conversation(stored["id"]) == before


def test_deletion_failure_rolls_back_message_and_conversation_timestamp(
    client, history_store, stored
):
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn, conn:
        conn.execute("""CREATE TRIGGER reject_message_delete BEFORE DELETE ON messages BEGIN
            SELECT RAISE(ABORT, 'private-storage-detail'); END""")
    response = delete(client, stored["id"], stored["messages"][1])
    assert response.status_code == 500
    assert "private-storage-detail" not in response.text
    assert history_store.get_conversation(stored["id"]) == stored


def test_delete_last_message_and_append_serialize_without_orphans(history_store):
    """两线程竞争真实 SQLite 写锁，允许任一顺序，但不能留下无归属消息。"""
    for _ in range(5):
        conv_id = history_store.create_conversation()["id"]
        history_store.add_message(conv_id, "user", "最后一条旧消息")
        target = history_store.get_conversation(conv_id)["messages"][0]
        barrier = Barrier(2)

        def remove(owned_id, owned_target, start):
            start.wait(timeout=10)
            return history_store.delete_message(
                owned_id, owned_target["id"], owned_target["revision"]
            )

        def append(owned_id, start):
            start.wait(timeout=10)
            try:
                history_store.add_messages(owned_id, [{"role": "user", "content": "并发新增"}])
                return True
            except PublicError as error:
                assert error.info.status_code == 404
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            removed = pool.submit(remove, conv_id, target, barrier)
            appended = pool.submit(append, conv_id, barrier)
            result = removed.result(timeout=15)
            survived = appended.result(timeout=15)
        after = history_store.get_conversation(conv_id)
        if survived:
            assert result["conversation_deleted"] is False
            assert [message["content"] for message in after["messages"]] == ["并发新增"]
        else:
            assert result["conversation_deleted"] is True
            assert after is None
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn:
        assert (
            conn.execute("""SELECT COUNT(*) FROM messages m LEFT JOIN conversations c
            ON m.conversation_id=c.id WHERE c.id IS NULL""").fetchone()[0]
            == 0
        )


def test_append_after_snapshot_survives_old_message_deletion(client, history_store, stored):
    target = stored["messages"][1]
    history_store.add_messages(
        stored["id"],
        [
            {"role": "user", "content": "并发新问题"},
            {"role": "assistant", "content": "并发新回复"},
        ],
    )
    before = history_store.get_conversation(stored["id"])
    response = delete(client, stored["id"], target)
    assert response.status_code == 200
    assert history_store.get_conversation(stored["id"])["messages"] == [
        message for message in before["messages"] if message["id"] != target["id"]
    ]


def test_empty_conversation_delete_failure_restores_last_message_and_metadata(
    client, history_store
):
    conv_id = history_store.create_conversation()["id"]
    history_store.add_message(conv_id, "user", "最后一条消息")
    before = history_store.get_conversation(conv_id)
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn, conn:
        conn.execute("""CREATE TRIGGER reject_empty_conversation BEFORE DELETE ON conversations
            BEGIN SELECT RAISE(ABORT, 'private-storage-detail'); END""")
    response = delete(client, conv_id, before["messages"][0])
    assert response.status_code == 500
    assert "private-storage-detail" not in response.text
    assert history_store.get_conversation(conv_id) == before


@pytest.mark.parametrize("message_id", [0, -1])
def test_message_id_must_be_positive(client, history_store, stored, message_id):
    response = delete(client, stored["id"], {**stored["messages"][0], "id": message_id})
    assert response.status_code == 422
    assert history_store.get_conversation(stored["id"]) == stored
