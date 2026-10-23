"""会话历史存储测试：验证持久化、会话隔离、事务和连接释放。"""

import json
import sqlite3
from contextlib import closing
from datetime import datetime
from unittest.mock import Mock

import pytest


@pytest.fixture
def tracked_connections(monkeypatch):
    """记录真实 SQLite 连接，以验证成功及异常路径都会释放连接。"""
    connections = []
    original_connect = sqlite3.connect

    def connect(*args, **kwargs):
        connection = original_connect(*args, **kwargs)
        connections.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", connect)
    return connections


@pytest.mark.parametrize("title", [None, "房屋租赁合同咨询"])
def test_create_conversation_persists_metadata(history_store, title):
    """默认或自定义标题以及创建时间可以从数据库完整读回。"""
    conversation = (
        history_store.create_conversation()
        if title is None
        else history_store.create_conversation(title)
    )

    assert conversation["id"]
    assert conversation["title"] == (title if title is not None else "新对话")
    assert datetime.fromisoformat(conversation["created_at"])
    assert conversation["created_at"] == conversation["updated_at"]
    assert history_store.get_conversation(conversation["id"]) == {
        **conversation,
        "messages": [],
    }
    assert history_store.list_conversations() == [conversation]


def test_created_conversations_have_distinct_ids(history_store):
    """连续创建的会话各自具有独立 ID。"""
    first = history_store.create_conversation()
    second = history_store.create_conversation()

    assert first["id"] != second["id"]
    assert len(history_store.list_conversations()) == 2


def test_missing_conversation_returns_none(history_store):
    """查询不存在的会话返回 None。"""
    assert history_store.get_conversation("missing-conversation") is None


def test_list_conversations_orders_by_latest_message(history_store, monkeypatch):
    """新消息使旧会话排到顶部，同时保留其创建时间。"""
    clock = Mock()
    clock.now.side_effect = [
        datetime(2026, 10, 20, 9),
        datetime(2026, 10, 21, 9),
        datetime(2026, 10, 22, 9),
    ]
    monkeypatch.setattr(history_store, "datetime", clock)
    first = history_store.create_conversation("旧会话")
    second = history_store.create_conversation("新会话")
    assert [item["id"] for item in history_store.list_conversations()] == [
        second["id"],
        first["id"],
    ]

    history_store.add_message(first["id"], "user", "继续咨询")

    conversations = history_store.list_conversations()
    assert [item["id"] for item in conversations] == [first["id"], second["id"]]
    assert conversations[0]["created_at"] == first["created_at"]
    assert conversations[0]["updated_at"] == datetime(2026, 10, 22, 9).isoformat()


def test_messages_preserve_order_and_optional_fields(history_store):
    """消息正文、附件名、合同数据和思维链可按发送顺序读回。"""
    conversation = history_store.create_conversation()
    contract_data = {
        "raw_text": "第一条：租金按月支付。",
        "risk_points": [{"quote": "租金按月支付", "level": "low", "bubble_text": "明确日期"}],
    }
    thinking_chain = [{"type": "tool", "label": "search_laws", "content": "检索完成"}]
    history_store.add_message(conversation["id"], "user", "请审查合同", "租赁合同.docx")
    history_store.add_message(
        conversation["id"],
        "assistant",
        "审查报告",
        contract_data=contract_data,
        thinking_chain=thinking_chain,
    )

    messages = history_store.get_conversation(conversation["id"])["messages"]

    assert len(messages) == 2
    assert messages[0] == {
        "role": "user",
        "content": "请审查合同",
        "file_name": "租赁合同.docx",
        "contract_data": None,
        "thinking_chain": [],
    }
    assert messages[1]["role"] == "assistant"
    assert messages[1]["content"] == "审查报告"
    assert messages[1]["file_name"] is None
    assert json.loads(messages[1]["contract_data"]) == contract_data
    assert messages[1]["thinking_chain"] == thinking_chain


@pytest.mark.parametrize("stored_chain", [None, "not-valid-json"])
def test_invalid_or_missing_thinking_chain_falls_back_to_empty(history_store, stored_chain):
    """缺失或损坏的旧版思维链不会阻止加载整个会话。"""
    conversation = history_store.create_conversation()
    history_store.add_message(conversation["id"], "assistant", "已有回复")
    with closing(sqlite3.connect(history_store.DB_PATH)) as connection, connection:
        connection.execute(
            "UPDATE messages SET thinking_chain=? WHERE conversation_id=?",
            (stored_chain, conversation["id"]),
        )

    messages = history_store.get_conversation(conversation["id"])["messages"]

    assert messages[0]["content"] == "已有回复"
    assert messages[0]["thinking_chain"] == []


def test_update_title_preserves_messages_and_other_conversations(history_store):
    """重命名只修改目标会话标题，不影响消息和其他会话。"""
    target = history_store.create_conversation("原标题")
    other = history_store.create_conversation("其他会话")
    history_store.add_message(target["id"], "user", "保留的消息")
    before = history_store.get_conversation(target["id"])

    history_store.update_title(target["id"], "新的中文标题")

    after = history_store.get_conversation(target["id"])
    assert after == {**before, "title": "新的中文标题"}
    assert history_store.get_conversation(other["id"])["title"] == "其他会话"


def test_rebuild_replaces_messages_and_preserves_other_conversations(history_store, monkeypatch):
    """重建后只保留新消息及附加数据，并更新目标会话时间。"""
    clock = Mock()
    clock.now.return_value = datetime(2026, 10, 20, 9)
    monkeypatch.setattr(history_store, "datetime", clock)
    target = history_store.create_conversation("目标会话")
    other = history_store.create_conversation("其他会话")
    history_store.add_message(target["id"], "user", "旧消息")
    history_store.add_message(other["id"], "user", "其他会话消息")
    other_before = history_store.get_conversation(other["id"])
    replacement = [
        {"role": "user", "content": "修改后的问题", "file_name": "合同.pdf"},
        {
            "role": "assistant",
            "content": "新的回复",
            "contract_data": {"raw_text": "合同原文", "risk_points": []},
            "thinking_chain": [{"type": "tool", "content": "法律检索"}],
        },
    ]
    clock.now.return_value = datetime(2026, 10, 23, 9)

    history_store.rebuild_messages(target["id"], replacement)

    rebuilt = history_store.get_conversation(target["id"])
    assert rebuilt["title"] == target["title"]
    assert rebuilt["created_at"] == target["created_at"]
    assert rebuilt["updated_at"] == datetime(2026, 10, 23, 9).isoformat()
    assert [message["content"] for message in rebuilt["messages"]] == [
        "修改后的问题",
        "新的回复",
    ]
    assert rebuilt["messages"][0]["file_name"] == "合同.pdf"
    assert json.loads(rebuilt["messages"][1]["contract_data"]) == replacement[1]["contract_data"]
    assert rebuilt["messages"][1]["thinking_chain"] == replacement[1]["thinking_chain"]
    assert history_store.get_conversation(other["id"]) == other_before


def test_rebuild_with_empty_list_clears_messages(history_store):
    """存储层允许清空消息，是否删除空会话由调用方决定。"""
    conversation = history_store.create_conversation()
    history_store.add_message(conversation["id"], "user", "待清空的消息")

    history_store.rebuild_messages(conversation["id"], [])

    assert history_store.get_conversation(conversation["id"])["messages"] == []


def test_rebuild_failure_preserves_original_messages(history_store, tracked_connections):
    """重建中途插入失败时回滚整笔事务，旧消息和会话时间保持完整。"""
    conversation = history_store.create_conversation()
    history_store.add_message(conversation["id"], "user", "原始问题")
    history_store.add_message(conversation["id"], "assistant", "原始回复")
    before = history_store.get_conversation(conversation["id"])

    with pytest.raises(sqlite3.IntegrityError):
        history_store.rebuild_messages(
            conversation["id"],
            [
                {"role": "user", "content": "已插入的新问题"},
                {"role": "assistant", "content": None},
            ],
        )

    assert history_store.get_conversation(conversation["id"]) == before
    for connection in tracked_connections:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            connection.execute("SELECT 1")


def test_delete_conversation_removes_its_messages_only(history_store):
    """删除会话后消息表无残留，其他会话及其消息保持完整。"""
    target = history_store.create_conversation()
    other = history_store.create_conversation()
    history_store.add_message(target["id"], "user", "待删除的问题")
    history_store.add_message(target["id"], "assistant", "待删除的回复")
    history_store.add_message(other["id"], "user", "保留的消息")
    other_before = history_store.get_conversation(other["id"])

    history_store.delete_conversation(target["id"])

    assert history_store.get_conversation(target["id"]) is None
    assert [item["id"] for item in history_store.list_conversations()] == [other["id"]]
    assert history_store.get_conversation(other["id"]) == other_before
    with closing(sqlite3.connect(history_store.DB_PATH)) as connection:
        count = connection.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id=?",
            (target["id"],),
        ).fetchone()[0]
    assert count == 0


def test_connections_close_after_success_and_early_return(history_store, tracked_connections):
    """常规读写、初始化和不存在会话的提前返回都会关闭连接。"""
    history_store._init_db()
    conversation = history_store.create_conversation()
    history_store.add_message(conversation["id"], "user", "测试消息")
    history_store.list_conversations()
    history_store.get_conversation(conversation["id"])
    history_store.get_conversation("missing-conversation")
    history_store.update_title(conversation["id"], "新标题")
    history_store.rebuild_messages(conversation["id"], [])
    history_store.delete_conversation(conversation["id"])

    assert tracked_connections
    for connection in tracked_connections:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            connection.execute("SELECT 1")
