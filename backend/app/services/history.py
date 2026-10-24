"""
会话历史持久化存储 — SQLite
"""

import hashlib
import json
import logging
import os
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from app.core.errors import (
    CONVERSATION_NOT_FOUND,
    MESSAGE_CHANGED,
    MESSAGE_NOT_EDITABLE,
    MESSAGE_NOT_FOUND,
    REPLY_CHANGED,
    REPORT_CHANGED,
    TITLE_CHANGED,
    PublicError,
)

logger = logging.getLogger(__name__)

DB_PATH = Path(
    os.environ.get(
        "LAW_AI_HISTORY_DB_PATH",
        Path(__file__).resolve().parent.parent.parent / "data" / "history.db",
    )
)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def _get_conn() -> Iterator[sqlite3.Connection]:
    """管理数据库事务，成功时提交、异常时回滚，并始终关闭连接。"""
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        with conn:
            yield conn
    except Exception:
        logger.exception("历史数据库操作失败")
        raise
    finally:
        conn.close()


def _init_db():
    with _get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '新对话',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                file_name TEXT,
                contract_data TEXT,
                thinking_chain TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

        """)


_init_db()


# ============================================================
# 增删改查
# ============================================================


def list_conversations() -> list[dict]:
    """获取全部会话列表，按更新时间倒序"""
    with _get_conn() as conn:
        rows = conn.execute("SELECT * FROM conversations ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]


def create_conversation(title: str = "新对话") -> dict:
    """创建新会话，返回会话 ID 和元信息"""
    cid = uuid.uuid4().hex[:12]
    now = datetime.now().isoformat()
    with _get_conn() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?)",
            (cid, title, now, now),
        )
    return {"id": cid, "title": title, "created_at": now, "updated_at": now}


def get_conversation(conv_id: str) -> dict | None:
    """获取单个会话详情，含全部消息记录"""
    with _get_conn() as conn:
        conv = conn.execute("SELECT * FROM conversations WHERE id=?", (conv_id,)).fetchone()
        if not conv:
            return None
        msgs = conn.execute(
            "SELECT id, role, content, file_name, contract_data, thinking_chain FROM messages WHERE conversation_id=? ORDER BY id",
            (conv_id,),
        ).fetchall()
    result = []
    for m in msgs:
        md = dict(m)
        md["revision"] = message_revision(md)
        if md.get("thinking_chain"):
            try:
                md["thinking_chain"] = json.loads(md["thinking_chain"])
            except (json.JSONDecodeError, TypeError):
                logger.warning("历史思维链格式无效，按空列表读取")
                md["thinking_chain"] = []
        else:
            md["thinking_chain"] = []
        result.append(md)
    return {
        **dict(conv),
        "messages": result,
    }


def conversation_exists(conv_id: str) -> bool:
    """检查会话是否存在，避免校验写入目标时加载全部消息。"""
    with _get_conn() as conn:
        return (
            conn.execute(
                "SELECT 1 FROM conversations WHERE id=?",
                (conv_id,),
            ).fetchone()
            is not None
        )


def message_revision(message: dict) -> str:
    """用已保存的正文及结构化数据标识版本，不修改旧数据库结构。"""
    values = [message.get(field) for field in ("content", "contract_data", "thinking_chain")]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False).encode("utf-8")).hexdigest()


def get_message(conv_id: str, message_id: int) -> dict | None:
    """按会话和稳定消息 ID 查询原始存储数据，不能跨会话取得报告。"""
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? AND id=?", (conv_id, message_id)
        ).fetchone()
    return dict(row) if row else None


def edit_user_message(conv_id: str, message_id: int, expected_revision: str, content: str) -> dict:
    """事务内校验用户消息的归属与版本，只改正文，保留附件及其他历史。"""
    with _get_conn() as conn:
        cursor = conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?",
            (datetime.now().isoformat(), conv_id),
        )
        if cursor.rowcount != 1:
            raise PublicError(CONVERSATION_NOT_FOUND)
        row = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? AND id=?", (conv_id, message_id)
        ).fetchone()
        if row is None:
            raise PublicError(MESSAGE_NOT_FOUND)
        original = dict(row)
        if original["role"] != "user":
            raise PublicError(MESSAGE_NOT_EDITABLE)
        if message_revision(original) != expected_revision:
            raise PublicError(MESSAGE_CHANGED)
        conn.execute(
            "UPDATE messages SET content=? WHERE conversation_id=? AND id=?",
            (content, conv_id, message_id),
        )
        revision = message_revision({**original, "content": content})
    logger.debug("用户消息正文更新完成")
    return {"message_id": message_id, "revision": revision, "content": content, "saved": True}


def delete_message(
    conv_id: str, message_id: int, expected_revision: str, preserve_empty_conversation: bool = False
) -> dict:
    """在写锁内校验归属和版本，只删除目标；空会话也在同一事务中清理。"""
    with _get_conn() as conn:
        cursor = conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?",
            (datetime.now().isoformat(), conv_id),
        )
        if cursor.rowcount != 1:
            raise PublicError(CONVERSATION_NOT_FOUND)
        row = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? AND id=?", (conv_id, message_id)
        ).fetchone()
        if row is None:
            raise PublicError(MESSAGE_NOT_FOUND)
        if message_revision(dict(row)) != expected_revision:
            raise PublicError(MESSAGE_CHANGED)
        conn.execute("DELETE FROM messages WHERE conversation_id=? AND id=?", (conv_id, message_id))
        remaining = conn.execute(
            "SELECT 1 FROM messages WHERE conversation_id=? LIMIT 1", (conv_id,)
        ).fetchone()
        # 客户端仍有未落库的其他消息时暂留会话，避免中断无关的在途回复。
        conversation_deleted = remaining is None and not preserve_empty_conversation
        if conversation_deleted:
            conn.execute("DELETE FROM conversations WHERE id=?", (conv_id,))
    logger.debug("单条消息删除完成：已清理空会话=%s", conversation_deleted)
    return {"message_id": message_id, "conversation_deleted": conversation_deleted}


def replace_contract_report(original: dict, contract_data: dict, thinking_chain: list) -> str:
    """完整结果生成后定点替换；版本冲突或事务失败时不覆盖原记录。"""
    content = contract_data["chat_reply"]
    encoded_contract = json.dumps(contract_data, ensure_ascii=False)
    encoded_thinking = json.dumps(thinking_chain, ensure_ascii=False) if thinking_chain else None
    with _get_conn() as conn:
        cursor = conn.execute(
            """UPDATE messages SET content=?, contract_data=?, thinking_chain=?
               WHERE id=? AND conversation_id=? AND role='assistant'
               AND content IS ? AND contract_data IS ? AND thinking_chain IS ?""",
            (
                content,
                encoded_contract,
                encoded_thinking,
                original["id"],
                original["conversation_id"],
                original["content"],
                original["contract_data"],
                original["thinking_chain"],
            ),
        )
        if cursor.rowcount != 1:
            raise PublicError(REPORT_CHANGED)
        conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?",
            (datetime.now().isoformat(), original["conversation_id"]),
        )
    return message_revision(
        {
            "content": content,
            "contract_data": encoded_contract,
            "thinking_chain": encoded_thinking,
        }
    )


def get_message_prefix(conv_id: str, message_id: int) -> list[dict]:
    """单次查询读取目标及此前记录，避免多次查询混用不同时间的上下文。"""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? AND id<=? ORDER BY id",
            (conv_id, message_id),
        ).fetchall()
    return [dict(row) for row in rows]


def _prefix_versions(messages: list[dict]) -> list[tuple]:
    return [
        (message["id"], message["role"], message.get("file_name"), message_revision(message))
        for message in messages
    ]


def replace_chat_reply(original_prefix: list[dict], content: str, thinking_chain: list) -> str:
    """回复及其输入上下文均未改变时才定点替换，允许后续轮次并发追加。"""
    original = original_prefix[-1]
    conv_id = original["conversation_id"]
    encoded_thinking = json.dumps(thinking_chain, ensure_ascii=False) if thinking_chain else None
    with _get_conn() as conn:
        cursor = conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?",
            (datetime.now().isoformat(), conv_id),
        )
        if cursor.rowcount != 1:
            raise PublicError(REPLY_CHANGED)
        current = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? AND id<=? ORDER BY id",
            (conv_id, original["id"]),
        ).fetchall()
        if _prefix_versions([dict(row) for row in current]) != _prefix_versions(original_prefix):
            raise PublicError(REPLY_CHANGED)
        cursor = conn.execute(
            "UPDATE messages SET content=?, thinking_chain=? WHERE conversation_id=? AND id=? AND role='assistant'",
            (content, encoded_thinking, conv_id, original["id"]),
        )
        if cursor.rowcount != 1:
            raise PublicError(REPLY_CHANGED)
    return message_revision({**original, "content": content, "thinking_chain": encoded_thinking})


def _insert_messages(conn, conv_id, messages, now):
    """在调用方事务内插入消息并更新会话时间。"""
    # 先取得写锁并在同一事务内确认会话仍存在，关闭路由校验与插入之间的竞态窗口。
    cursor = conn.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, conv_id))
    if cursor.rowcount != 1:
        raise PublicError(CONVERSATION_NOT_FOUND)
    saved = []
    for message in messages:
        encoded_contract = (
            json.dumps(message["contract_data"], ensure_ascii=False)
            if message.get("contract_data")
            else None
        )
        encoded_thinking = (
            json.dumps(message["thinking_chain"], ensure_ascii=False)
            if message.get("thinking_chain")
            else None
        )
        cursor = conn.execute(
            "INSERT INTO messages (conversation_id, role, content, file_name, contract_data, thinking_chain, created_at) VALUES (?,?,?,?,?,?,?)",
            (
                conv_id,
                message.get("role", ""),
                message.get("content", ""),
                message.get("file_name"),
                encoded_contract,
                encoded_thinking,
                now,
            ),
        )
        saved.append(
            {
                "id": cursor.lastrowid,
                "role": message.get("role", ""),
                "revision": message_revision(
                    {
                        "content": message.get("content", ""),
                        "contract_data": encoded_contract,
                        "thinking_chain": encoded_thinking,
                    }
                ),
            }
        )
    return saved


def add_messages(conv_id: str, messages: list[dict]):
    """在同一事务中保存一组消息，任一写入失败则整组回滚。"""
    with _get_conn() as conn:
        saved = _insert_messages(conn, conv_id, messages, datetime.now().isoformat())
    logger.debug("会话消息保存完成：消息数=%d", len(messages))
    return saved


def add_message(
    conv_id: str,
    role: str,
    content: str = "",
    file_name: str | None = None,
    contract_data: dict | None = None,
    thinking_chain: list | None = None,
):
    """保存单条消息，复用批量写入的事务与序列化规则。"""
    add_messages(
        conv_id,
        [
            {
                "role": role,
                "content": content,
                "file_name": file_name,
                "contract_data": contract_data,
                "thinking_chain": thinking_chain,
            }
        ],
    )


def update_title(conv_id: str, title: str, expected_title: str | None = None) -> dict:
    """原子校验原标题并更新，只在事务提交成功后返回明确回执。"""
    with _get_conn() as conn:
        query = "UPDATE conversations SET title=? WHERE id=?"
        parameters = [title, conv_id]
        if expected_title is not None:
            query += " AND title=?"
            parameters.append(expected_title)
        result = conn.execute(query, parameters)
        if result.rowcount != 1:
            if not conn.execute("SELECT 1 FROM conversations WHERE id=?", (conv_id,)).fetchone():
                raise PublicError(CONVERSATION_NOT_FOUND)
            raise PublicError(TITLE_CHANGED)
    return {"conversation_id": conv_id, "title": title, "saved": True}


def delete_conversation(conv_id: str):
    """删除会话及其全部消息"""
    with _get_conn() as conn:
        conn.execute("DELETE FROM messages WHERE conversation_id=?", (conv_id,))
        conn.execute("DELETE FROM conversations WHERE id=?", (conv_id,))
