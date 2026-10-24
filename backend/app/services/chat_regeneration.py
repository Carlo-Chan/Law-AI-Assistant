"""使用服务端保存的问题与当时的历史重新生成，完整结果才定点替换。"""

from contextlib import aclosing

from app.core.errors import (
    INVALID_REPLY,
    MESSAGE_NOT_FOUND,
    REPLY_CHANGED,
    REPLY_NOT_SUPPORTED,
    REPLY_SOURCE_MISSING,
    PublicError,
)
from app.services import history
from app.services.generation_progress import record_generation_step


def load_chat_source(
    conv_id: str, message_id: int, revision: str
) -> tuple[list[dict], str, list[dict]]:
    """不采信客户端传入的历史，只使用目标之前的已保存上下文。"""
    prefix = history.get_message_prefix(conv_id, message_id)
    if not prefix or prefix[-1]["id"] != message_id or prefix[-1]["role"] != "assistant":
        raise PublicError(MESSAGE_NOT_FOUND)
    target = prefix[-1]
    if history.message_revision(target) != revision:
        raise PublicError(REPLY_CHANGED)
    if target.get("contract_data"):
        raise PublicError(REPLY_NOT_SUPPORTED)
    if len(prefix) < 2 or prefix[-2]["role"] != "user" or not prefix[-2]["content"].strip():
        raise PublicError(REPLY_SOURCE_MISSING)
    user = prefix[-2]
    # 当前成对保存会连续分配 ID；存在缺口时保守拒绝，不能把更早的问题冒认成来源。
    if user["id"] + 1 != target["id"]:
        raise PublicError(REPLY_SOURCE_MISSING)
    if user.get("file_name"):
        raise PublicError(REPLY_NOT_SUPPORTED)
    context = [{"role": message["role"], "content": message["content"]} for message in prefix[:-2]]
    return prefix, user["content"], context


async def regenerate_chat_reply(prefix: list[dict], events):
    """流式预览不会写入数据库，合法结束并提交成功后才发送保存确认。"""
    steps = []
    chunks = []
    async with aclosing(events):
        async for event in events:
            if not isinstance(event, dict) or "type" not in event:
                raise PublicError(INVALID_REPLY)
            kind = event["type"]
            if not isinstance(kind, str) or kind not in {
                "thinking",
                "thinking_reasoning",
                "thinking_reasoning_token",
                "tool_result",
                "tool_result_chunk",
                "tool_result_end",
                "token",
                "done",
                "error",
            }:
                raise PublicError(INVALID_REPLY)
            if kind == "error":
                yield event
                return
            if kind == "token":
                if not isinstance(event.get("content"), str):
                    raise PublicError(INVALID_REPLY)
                chunks.append(event["content"])
            if kind == "done":
                content = "".join(chunks)
                if not content.strip() or event.get("aborted"):
                    raise PublicError(INVALID_REPLY)
                revision = history.replace_chat_reply(prefix, content, steps)
                user = prefix[-2]
                yield {
                    "type": "done",
                    "chat_reply": content,
                    "message_id": prefix[-1]["id"],
                    "revision": revision,
                    "source_message_id": user["id"],
                    "source_revision": history.message_revision(user),
                    "query": user["content"],
                    "thinking_chain": steps,
                    "saved": True,
                }
                return
            record_generation_step(steps, event)
            yield event
    raise PublicError(INVALID_REPLY)
