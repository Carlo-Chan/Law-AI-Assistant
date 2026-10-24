"""标题保存回执与条件更新测试，全程使用隔离数据库。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from app.core.errors import PublicError
from app.main import app


@pytest.fixture
def client(history_store):
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def test_title_update_returns_saved_identity(history_store):
    conversation = history_store.create_conversation("原标题")
    result = history_store.update_title(conversation["id"], "新标题", "原标题")
    assert result == {
        "conversation_id": conversation["id"],
        "title": "新标题",
        "saved": True,
    }


def test_changed_title_cannot_be_overwritten_by_stale_editor(history_store):
    conversation = history_store.create_conversation("原标题")
    history_store.update_title(conversation["id"], "其他位置的新标题")
    with pytest.raises(PublicError) as caught:
        history_store.update_title(conversation["id"], "旧编辑的修改", "原标题")
    assert caught.value.info.code == "title_changed"
    assert history_store.get_conversation(conversation["id"])["title"] == "其他位置的新标题"


def test_deleted_conversation_cannot_receive_success_ack(history_store):
    with pytest.raises(PublicError) as caught:
        history_store.update_title("missing", "新标题")
    assert caught.value.info.code == "conversation_not_found"


def test_legacy_update_preserves_messages_and_metadata(history_store):
    conversation = history_store.create_conversation("原始标题")
    history_store.add_messages(
        conversation["id"],
        [{"role": "user", "content": "问题"}, {"role": "assistant", "content": "回答"}],
    )
    before = history_store.get_conversation(conversation["id"])
    result = history_store.update_title(conversation["id"], "新标题")
    assert result["saved"] is True
    assert history_store.get_conversation(conversation["id"]) == {**before, "title": "新标题"}


def test_same_title_can_be_confirmed_again(history_store):
    conversation = history_store.create_conversation("相同标题")
    assert history_store.update_title(conversation["id"], "相同标题", "相同标题")["saved"]


def test_parallel_editors_only_one_wins(history_store):
    conversation = history_store.create_conversation("原标题")
    barrier = Barrier(2)

    def save(title):
        barrier.wait(timeout=5)
        try:
            history_store.update_title(conversation["id"], title, "原标题")
            return title
        except PublicError as error:
            return error.info.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(save, ["甲编辑", "乙编辑"]))
    assert results.count("title_changed") == 1
    winner = next(result for result in results if result != "title_changed")
    assert history_store.get_conversation(conversation["id"])["title"] == winner


def test_commit_failure_does_not_return_ack_or_change_title(history_store, monkeypatch):
    conversation = history_store.create_conversation("原标题")
    original = history_store._get_conn

    @contextmanager
    def fail_commit():
        with original() as connection:
            yield connection
            raise RuntimeError("模拟提交失败")

    with monkeypatch.context() as isolated:
        isolated.setattr(history_store, "_get_conn", fail_commit)
        with pytest.raises(RuntimeError):
            history_store.update_title(conversation["id"], "新标题", "原标题")
    assert history_store.get_conversation(conversation["id"])["title"] == "原标题"


def test_title_route_returns_identity_after_commit(client, history_store):
    conversation = history_store.create_conversation("原标题")
    result = client.post(
        f"/api/conversations/{conversation['id']}/title",
        json={"title": "新标题", "expected_title": "原标题"},
    )
    assert result.status_code == 200
    assert result.json()["data"] == {
        "ok": True,
        "conversation_id": conversation["id"],
        "title": "新标题",
        "saved": True,
    }


def test_title_route_conflict_is_safe_and_preserves_latest(client, history_store):
    conversation = history_store.create_conversation("保密租赁事项")
    result = client.post(
        f"/api/conversations/{conversation['id']}/title",
        json={"title": "旧编辑修改", "expected_title": "旧版本"},
    )
    assert result.status_code == 409
    assert result.json()["code"] == "title_changed"
    assert "保密租赁事项" not in result.text
    assert history_store.get_conversation(conversation["id"])["title"] == "保密租赁事项"


@pytest.mark.parametrize("expected", [12, [], {}])
def test_invalid_title_condition_never_updates(client, history_store, expected):
    conversation = history_store.create_conversation("原标题")
    result = client.post(
        f"/api/conversations/{conversation['id']}/title",
        json={"title": "新标题", "expected_title": expected},
    )
    assert result.status_code == 422
    assert history_store.get_conversation(conversation["id"])["title"] == "原标题"


def test_automatic_naming_condition_does_not_replace_custom_title(client, history_store):
    conversation = history_store.create_conversation("用户自定义标题")
    result = client.post(
        f"/api/conversations/{conversation['id']}/title",
        json={"title": "问题自动命名", "expected_title": "新对话"},
    )
    assert result.status_code == 409
    assert history_store.get_conversation(conversation["id"])["title"] == "用户自定义标题"
