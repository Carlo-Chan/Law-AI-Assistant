"""
会话历史持久化存储 — SQLite
"""
import sqlite3
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from functools import lru_cache

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "history.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


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

    conn.close()


_init_db()


# ============================================================
# CRUD
# ============================================================


def list_conversations() -> list[dict]:
    """获取全部会话列表，按更新时间倒序"""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
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
        conv = conn.execute(
            "SELECT * FROM conversations WHERE id=?", (conv_id,)).fetchone()
        if not conv:
            return None
        msgs = conn.execute(
            "SELECT role, content, file_name, contract_data, thinking_chain FROM messages WHERE conversation_id=? ORDER BY id",
            (conv_id,),
        ).fetchall()
    result = []
    for m in msgs:
        md = dict(m)
        if md.get("thinking_chain"):
            try:
                md["thinking_chain"] = json.loads(md["thinking_chain"])
            except (json.JSONDecodeError, TypeError):
                md["thinking_chain"] = []
        else:
            md["thinking_chain"] = []
        result.append(md)
    return {
        **dict(conv),
        "messages": result,
    }


def add_message(conv_id: str, role: str, content: str = "",
                file_name: str | None = None, contract_data: dict | None = None,
                thinking_chain: list | None = None):
    now = datetime.now().isoformat()
    with _get_conn() as conn:
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, file_name, contract_data, thinking_chain, created_at) VALUES (?,?,?,?,?,?,?)",
            (conv_id, role, content, file_name,
             json.dumps(contract_data,
                        ensure_ascii=False) if contract_data else None,
             json.dumps(thinking_chain,
                        ensure_ascii=False) if thinking_chain else None,
             now),
        )
        # 更新对话时间戳
        conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?", (now, conv_id))


def update_title(conv_id: str, title: str):
    """更新会话标题"""
    with _get_conn() as conn:
        conn.execute("UPDATE conversations SET title=? WHERE id=?",
                     (title, conv_id))


def rebuild_messages(conv_id: str, messages: list[dict]):
    "Delete all messages for a conversation and re-insert from list"
    with _get_conn() as conn:
        conn.execute(
            "DELETE FROM messages WHERE conversation_id=?", (conv_id,))
        now = datetime.now().isoformat()
        for m in messages:
            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, file_name, contract_data, thinking_chain, created_at) VALUES (?,?,?,?,?,?,?)",
                (conv_id, m.get("role", ""), m.get("content", ""), m.get("file_name"),
                 json.dumps(m.get("contract_data"), ensure_ascii=False) if m.get(
                     "contract_data") else None,
                 json.dumps(m.get("thinking_chain"), ensure_ascii=False) if m.get(
                     "thinking_chain") else None,
                 now),
            )
        conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?", (now, conv_id))


def delete_conversation(conv_id: str):
    """删除会话及其全部消息"""
    with _get_conn() as conn:
        conn.execute(
            "DELETE FROM messages WHERE conversation_id=?", (conv_id,))
        conn.execute("DELETE FROM conversations WHERE id=?", (conv_id,))
