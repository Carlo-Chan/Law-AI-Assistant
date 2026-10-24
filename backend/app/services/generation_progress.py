"""咨询与合同重跑共用的工具过程记录，不把旧回复的过程混入新结果。"""


def record_generation_step(steps: list, event: dict):
    """保持与前端工具轨迹一致的字段和分片拼接规则。"""
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
