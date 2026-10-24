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
from app.services.contract_instructions import normalize_contract_instruction
from app.services.generation_progress import record_generation_step


def load_contract_source(conv_id: str, message_id: int, revision: str) -> tuple[dict, str, str]:
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
    instruction = normalize_contract_instruction(data.get("instruction", ""))
    return original, raw_text, instruction


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
            record_generation_step(steps, event)
            yield event
    raise PublicError(INVALID_REPORT)
