"""会话删除与写入竞争：路由前置校验通过不代表写入时目标仍然存在。"""

import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from app.core.errors import PublicError
from app.main import app


def test_deleted_conversation_cannot_receive_orphan_messages(history_store):
    conv_id = history_store.create_conversation()["id"]
    history_store.delete_conversation(conv_id)
    with pytest.raises(PublicError) as failure:
        history_store.add_messages(
            conv_id, [{"role": "assistant", "content": "删除后才到达的后台回复"}]
        )
    assert failure.value.info.status_code == 404
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0


def test_delete_between_route_check_and_storage_returns_404(history_store, monkeypatch):
    conv_id = history_store.create_conversation()["id"]
    original_exists = history_store.conversation_exists

    def check_then_delete(target):
        existed = original_exists(target)
        history_store.delete_conversation(target)
        return existed

    monkeypatch.setattr(history_store, "conversation_exists", check_then_delete)
    payload = {"user_content": "问题", "assistant_content": "迟到回复"}
    with TestClient(app) as client:
        response = client.post(f"/api/conversations/{conv_id}/messages", json=payload)
    assert response.status_code == 404
    assert response.json()["detail"] == "会话不存在"
    assert history_store.get_conversation(conv_id) is None
    with closing(sqlite3.connect(history_store.DB_PATH)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
