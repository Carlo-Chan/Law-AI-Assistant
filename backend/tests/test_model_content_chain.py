"""真实编排处理不同文本载荷；只替换 Agent，不连接网络、模型或历史数据库。"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

from app.agent import chain
from app.core.errors import PublicError

HIDDEN = "不可展示的推理和附件元数据"
FORMATS = ["string", "strings", "text_blocks", "mixed"]
RAW_TEXT = "押金3000元。"
REPORT = {
    "chat_reply": "# 合同审查报告\n\n请明确押金退还条件。",
    "risk_points": [
        {"key_phrase": "押金3000元", "level": "low", "bubble_text": "建议明确退还期限。"}
    ],
}


def formatted(text, form):
    """模拟标准正文、分片字符串及带非正文数据的内容块。"""
    if form == "string":
        return text
    first, rest = text[:3], text[3:]
    if form == "strings":
        return [first, rest]
    blocks = [{"type": "text", "text": first}, {"type": "text", "text": rest}]
    if form == "text_blocks":
        return blocks
    return [
        {"type": "thinking", "thinking": HIDDEN, "text": HIDDEN},
        blocks[0],
        {"type": "reasoning", "reasoning": HIDDEN, "text": HIDDEN},
        {**blocks[1], "annotations": [{"text": HIDDEN}]},
        {"type": "image", "url": HIDDEN, "text": HIDDEN},
    ]


def install_stream(monkeypatch, agent_name, events):
    async def generate(*args, **kwargs):
        for event in events:
            yield event

    monkeypatch.setattr(chain, agent_name, SimpleNamespace(astream_events=generate))
    monkeypatch.setattr(chain.asyncio, "sleep", AsyncMock())


def model_event(content):
    return {
        "event": "on_chat_model_stream",
        "data": {
            "chunk": AIMessageChunk(
                content=content, additional_kwargs={"reasoning_content": HIDDEN}
            )
        },
    }


def tool_events(form):
    return [
        model_event(formatted("先核对法条", form)),
        {"event": "on_tool_start", "name": "search_laws", "data": {}},
        {
            "event": "on_tool_end",
            "name": "search_laws",
            "data": {
                "output": ToolMessage(
                    content=formatted("合成法条正文", form), tool_call_id="call-1"
                )
            },
        },
    ]


@pytest.mark.parametrize("form", FORMATS)
async def test_non_stream_chat_returns_text_and_text_only_tool_sources(monkeypatch, form):
    reply = "第一段\n\n第二段 😀 3000元"
    agent = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value={
                "messages": [
                    HumanMessage(content="合成问题"),
                    AIMessage(content="较早的过程文字"),
                    ToolMessage(
                        content=formatted("合成法条正文", form),
                        tool_call_id="call-1",
                        name="search_laws",
                    ),
                    AIMessage(
                        content=formatted(reply, form),
                        additional_kwargs={"reasoning_content": HIDDEN},
                    ),
                ]
            }
        )
    )
    monkeypatch.setattr(chain, "chat_agent", agent)
    result = await chain.run_chat("合成问题")
    assert result == {
        "reply": reply,
        "sources": [{"tool": "search_laws", "snippet": "合成法条正文"}],
    }
    assert HIDDEN not in json.dumps(result, ensure_ascii=False)


@pytest.mark.parametrize("form", FORMATS)
async def test_non_stream_contract_parses_normalized_text_without_changing_metadata(
    monkeypatch, form
):
    source = json.dumps(REPORT, ensure_ascii=True)
    agent = SimpleNamespace(
        ainvoke=AsyncMock(return_value={"messages": [AIMessage(content=formatted(source, form))]})
    )
    monkeypatch.setattr(chain, "contract_agent", agent)
    result = await chain.run_contract_analysis(RAW_TEXT, "核对押金")
    assert result == {
        **REPORT,
        "raw_text": RAW_TEXT,
        "instruction": "核对押金",
        "risk_points": [{**REPORT["risk_points"][0], "quote": "押金3000元"}],
    }
    assert agent.ainvoke.call_args.kwargs == {"config": {"recursion_limit": 12}}


@pytest.mark.parametrize("form", FORMATS)
@pytest.mark.parametrize("tools", [False, True])
async def test_chat_stream_preserves_reply_and_existing_tool_event_protocol(
    monkeypatch, form, tools
):
    reply = "第一段\n\n第二段 😀 3000元"
    events = tool_events(form) if tools else []
    events += [model_event(formatted(reply[:4], form)), model_event(formatted(reply[4:], form))]
    install_stream(monkeypatch, "chat_agent", events)
    result = [event async for event in chain.run_chat_stream("合成问题")]
    assert "".join(event["content"] for event in result if event["type"] == "token") == reply
    assert result[-1] == {"type": "done"}
    assert HIDDEN not in json.dumps(result, ensure_ascii=False)
    assert not any(event["type"] == "error" for event in result)
    if tools:
        assert {"type": "thinking_reasoning", "content": "先核对法条"} in result
        assert {"type": "thinking", "label": "search_laws"} in result
        assert (
            "".join(event["content"] for event in result if event["type"] == "tool_result_chunk")
            == "合成法条正文"
        )
        assert {"type": "tool_result_end", "tool": "search_laws"} in result
    else:
        assert all(event["type"] in {"token", "done"} for event in result)


@pytest.mark.parametrize("form", FORMATS)
@pytest.mark.parametrize("tools", [False, True])
async def test_contract_stream_preserves_json_fragments_quotes_and_tool_completion(
    monkeypatch, form, tools
):
    source = json.dumps(REPORT, ensure_ascii=True)
    events = tool_events(form) if tools else []
    events += [model_event(formatted(source[:13], form)), model_event(formatted(source[13:], form))]
    install_stream(monkeypatch, "contract_agent", events)
    result = [event async for event in chain.run_contract_analysis_stream(RAW_TEXT, "核对押金")]
    assert (
        "".join(event["content"] for event in result if event["type"] == "token")
        == REPORT["chat_reply"]
    )
    assert result[-1] == {
        "type": "done",
        "raw_text": RAW_TEXT,
        "instruction": "核对押金",
        **REPORT,
        "risk_points": [{**REPORT["risk_points"][0], "quote": "押金3000元"}],
    }
    assert HIDDEN not in json.dumps(result, ensure_ascii=False)
    if tools:
        assert {"type": "tool_result_end", "tool": "search_laws"} in result
    else:
        assert all(event["type"] in {"token", "done"} for event in result)


@pytest.mark.parametrize("mode", ["chat", "contract"])
@pytest.mark.parametrize(
    "ending", ["empty", "blank", "blocks", "reasoning", "tool_call", "tool_result", "user", "none"]
)
async def test_non_stream_never_reuses_history_or_process_as_missing_final_reply(
    monkeypatch, mode, ending
):
    previous = json.dumps(REPORT, ensure_ascii=False) if mode == "contract" else "旧回复不能返回"
    messages = [AIMessage(content=previous)]
    if ending == "empty":
        messages.append(AIMessage(content=""))
    if ending == "blank":
        messages.append(AIMessage(content=" \n\t"))
    if ending == "blocks":
        messages.append(AIMessage(content=[]))
    if ending == "reasoning":
        messages.append(AIMessage(content=[{"type": "reasoning", "text": HIDDEN}]))
    if ending == "tool_call":
        messages.append(
            AIMessage(
                content=previous, tool_calls=[{"name": "search_laws", "args": {}, "id": "pending"}]
            )
        )
    if ending == "tool_result":
        messages.append(ToolMessage(content="仅有工具结果", tool_call_id="pending"))
    if ending == "user":
        messages.append(HumanMessage(content="本轮尚无回复"))
    if ending == "none":
        messages = []
    monkeypatch.setattr(
        chain,
        mode + "_agent",
        SimpleNamespace(ainvoke=AsyncMock(return_value={"messages": messages})),
    )
    with pytest.raises(PublicError) as error:
        if mode == "chat":
            await chain.run_chat("问题")
        else:
            await chain.run_contract_analysis(RAW_TEXT)
    assert error.value.info.code == ("invalid_model_reply" if mode == "chat" else "invalid_report")
    assert HIDDEN not in str(error.value)


@pytest.mark.parametrize("mode", ["chat", "contract"])
@pytest.mark.parametrize("form", ["empty", "reasoning", "tool_only"])
async def test_stream_without_final_body_ends_with_fixed_error_not_blank_success(
    monkeypatch, mode, form
):
    events = tool_events("mixed") if form == "tool_only" else []
    content = "" if form == "empty" else [{"type": "reasoning", "text": HIDDEN}]
    events.append(model_event(content))
    install_stream(monkeypatch, mode + "_agent", events)
    generate = (
        chain.run_chat_stream("问题")
        if mode == "chat"
        else chain.run_contract_analysis_stream(RAW_TEXT)
    )
    result = [event async for event in generate]
    assert result[-1]["type"] == "error"
    assert result[-1]["code"] == ("invalid_model_reply" if mode == "chat" else "invalid_report")
    assert not any(event["type"] in {"done", "token"} for event in result)
    assert HIDDEN not in json.dumps(result, ensure_ascii=False)


async def test_ignored_tool_blocks_still_emit_completion_and_allow_final_reply(monkeypatch):
    events = [
        {"event": "on_tool_start", "name": "search_laws", "data": {}},
        {
            "event": "on_tool_end",
            "name": "search_laws",
            "data": {
                "output": ToolMessage(
                    content=[{"type": "image", "text": HIDDEN}], tool_call_id="call-1"
                )
            },
        },
        model_event("最终正文"),
    ]
    install_stream(monkeypatch, "chat_agent", events)
    result = [event async for event in chain.run_chat_stream("合成问题")]
    assert not any(event["type"] == "tool_result_chunk" for event in result)
    assert {"type": "tool_result_end", "tool": "search_laws"} in result
    assert result[-1] == {"type": "done"}


async def test_stream_cancellation_propagates_without_faking_done_or_error(monkeypatch):
    async def cancelled(*args, **kwargs):
        yield model_event([{"type": "text", "text": "未完成"}])
        raise asyncio.CancelledError

    monkeypatch.setattr(chain, "chat_agent", SimpleNamespace(astream_events=cancelled))
    with pytest.raises(asyncio.CancelledError):
        async for _event in chain.run_chat_stream("合成问题"):
            pytest.fail("取消前不能把未完成缓冲冒充最终回复")
