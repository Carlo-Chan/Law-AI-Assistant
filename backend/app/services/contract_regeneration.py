"""从目标报告已保存的合同原文重跑，不在生成前删除历史记录。"""

import json
from contextlib import aclosing

from app.core.errors import (
    CONTRACT_SOURCE_MISSING,
    INVALID_REPORT,
    REPORT_CHANGED,
    REPORT_NOT_FOUND,
    PublicError,
)
from app.services import history


def load_contract_source(conv_id: str, message_id: int, revision: str) -> tuple[dict, str]:
    """在调用模型前检查归属、版本及原文，缺少原文才要求重新上传。"""
    original = history.get_message(conv_id, message_id)
    if not original or original["role"] != "assistant":
        raise PublicError(REPORT_NOT_FOUND)
    if history.message_revision(original) != revision:
        raise PublicError(REPORT_CHANGED)
    try:
        data = json.loads(original["contract_data"] or "null")
    except (TypeError, json.JSONDecodeError) as error:
        raise PublicError(CONTRACT_SOURCE_MISSING) from error
    raw_text = data.get("raw_text") if isinstance(data, dict) else None
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise PublicError(CONTRACT_SOURCE_MISSING)
    return original, raw_text


def _record_step(steps: list, event: dict):
    """保存与前端现有工具轨迹一致的过程数据，不将旧报告过程混入新报告。"""
    kind = event["type"]
    if kind == "thinking":
        steps.append({"type": "tool", "label": event["label"]})
    elif kind in ("thinking_reasoning", "thinking_reasoning_token"):
        if not steps or steps[-1]["type"] != "reasoning":
            steps.append({"type": "reasoning", "label": ""})
        if kind == "thinking_reasoning":
            steps[-1]["label"] = event["content"]
        else:
            steps[-1]["label"] += event["content"]
    elif kind == "tool_result":
        steps.append({"type": "done", "label": event["tool"] + " 完成", "snippet": event["output"]})
    elif kind == "tool_result_chunk":
        if event.get("first"):
            steps.append(
                {"type": "done", "label": event["tool"] + " 完成", "snippet": event["content"]}
            )
        elif steps and steps[-1]["type"] == "done":
            steps[-1]["snippet"] += event["content"]


async def regenerate_report(original: dict, events, validate_result):
    """仅在合法结束帧生成且数据库提交成功后通知客户端替换报告。"""
    steps = []
    async with aclosing(events):
        async for event in events:
            if event["type"] == "error":
                yield event
                return
            if event["type"] == "done":
                result = validate_result(event)
                revision = history.replace_contract_report(original, result, steps)
                yield {
                    "type": "done",
                    **result,
                    "message_id": original["id"],
                    "revision": revision,
                    "thinking_chain": steps,
                    "saved": True,
                }
                return
            _record_step(steps, event)
            yield event
    raise PublicError(INVALID_REPORT)
