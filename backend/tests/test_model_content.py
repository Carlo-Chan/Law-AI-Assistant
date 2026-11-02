"""标准正文提取回归；不读取供应商推理字段，不把任意对象序列化为回复。"""

from copy import deepcopy

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.agent.model_content import extract_final_reply, extract_text_content


@pytest.mark.parametrize(
    "text", ["", " \n\t", "中文 😀 𠮷", "首段\n\n第二段\t3000元", "\ufeff甲\u00a0乙"]
)
def test_strings_are_preserved_exactly(text):
    assert extract_text_content(text) == text


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (["金", "额", "3000", "元"], "金额3000元"),
        (
            [{"type": "text", "text": "第一段\n"}, "\n", {"type": "text", "text": "第二段"}],
            "第一段\n\n第二段",
        ),
        (
            [{"type": "text", "text": '{"chat_reply":"\\u'}, {"type": "text", "text": '62a5"}'}],
            '{"chat_reply":"\\u62a5"}',
        ),
        (
            [
                {
                    "type": "text",
                    "text": "正文",
                    "annotations": [{"text": "不应展示"}],
                    "extras": {"text": "不应展示"},
                }
            ],
            "正文",
        ),
        (
            [
                {"type": "text"},
                {"type": "text", "text": 123},
                {"type": "text", "text": None},
                {"type": "text", "text": ["不猜测"]},
            ],
            "",
        ),
        ([None, 123, False, ["不递归"], {"text": "缺少类型"}], ""),
    ],
)
def test_only_explicit_text_blocks_are_concatenated_without_rewriting(content, expected):
    original = deepcopy(content)
    assert extract_text_content(content) == expected
    assert content == original


@pytest.mark.parametrize(
    "kind",
    [
        "thinking",
        "reasoning",
        "redacted_thinking",
        "image",
        "audio",
        "tool_call",
        "tool_use",
        "non_standard",
        "output_text",
        "unknown",
    ],
)
def test_other_block_types_never_become_text_even_with_a_text_field(kind):
    assert extract_text_content([{"type": kind, "text": "不可展示", "reasoning": "不可展示"}]) == ""


@pytest.mark.parametrize(
    "content",
    [None, 1, False, {}, {"type": "text", "text": "单独字典不猜测"}, ("元组不属于协议",), object()],
)
def test_unknown_top_level_values_do_not_raise_or_leak_object_representation(content):
    assert extract_text_content(content) == ""


def test_final_reply_ignores_reasoning_metadata_and_earlier_messages():
    messages = [
        AIMessage(content="较早的回复"),
        HumanMessage(content="新的问题"),
        AIMessage(
            content=[{"type": "text", "text": "最终正文"}],
            additional_kwargs={"reasoning_content": "不可展示"},
        ),
    ]
    assert extract_final_reply(messages) == "最终正文"


@pytest.mark.parametrize(
    "ending",
    [
        HumanMessage(content="等待回复"),
        ToolMessage(content="只有工具结果", tool_call_id="pending"),
        AIMessage(content="", tool_calls=[{"name": "search_laws", "args": {}, "id": "pending"}]),
        AIMessage(content=[]),
    ],
)
def test_missing_final_assistant_text_never_uses_earlier_reply(ending):
    assert extract_final_reply([AIMessage(content="不能回退到这里"), ending]) == ""


@pytest.mark.parametrize("messages", [[], None, {}, (AIMessage(content="不猜测元组"),)])
def test_invalid_message_containers_have_no_final_reply(messages):
    assert extract_final_reply(messages) == ""
