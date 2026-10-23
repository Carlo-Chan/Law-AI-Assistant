"""合同审查文本处理测试：覆盖原文匹配、JSON 容错和报告解码。"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage

from app.agent import chain


@pytest.mark.parametrize(
    ("raw_text", "phrase", "expected"),
    [
        ("甲方有权没收全部押金。", "没收全部押金", "没收全部押金"),
        (
            "违约金为每日 5%，按租金总额计算。",
            "违约金为每日，按租金总额计算",
            "违约金为每日 5%，按租金总额计算",
        ),
        ("甲方应当\n退还押金。", "甲方应当退还押金", "甲方应当\n退还押金"),
        ("租金为 2000 元，押金为 1000 元。", "1000 元", "1000 元"),
        ("Payment is due monthly.", "Payment is due monthly", "Payment is due monthly"),
        ("甲方应当退还押金。", "乙方无需支付租金", None),
        ("合同原文", "", None),
        ("合同原文", "   ", None),
        ("", "合同", None),
    ],
)
def test_fuzzy_match_returns_original_quote(raw_text, phrase, expected):
    """引用保留原文字符，精确匹配优先，中文引用可容忍标点及空白差异。"""
    assert chain.fuzzy_match(raw_text, phrase) == expected


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('{"chat_reply":"报告","risk_points":[]}', {"chat_reply": "报告", "risk_points": []}),
        (
            '分析完成。\n```json\n{"risk_points":[],"chat_reply":"报告"}\n```\n结束。',
            {"risk_points": [], "chat_reply": "报告"},
        ),
        ('{"chat_reply":"报告" "risk_points":[]}', {"chat_reply": "报告", "risk_points": []}),
        (
            '{"chat_reply":"报告\n下一段","risk_points":[]}',
            {"chat_reply": "报告\n下一段", "risk_points": []},
        ),
        (
            '{"chat_reply":"请补充 {约定" "risk_points":[]}',
            {"chat_reply": "请补充 {约定", "risk_points": []},
        ),
        (
            '{"chat_reply":"请补充 } 以及 \\"说明\\"" "risk_points":[]}',
            {"chat_reply": '请补充 } 以及 "说明"', "risk_points": []},
        ),
    ],
)
def test_parse_json_repairs_report_without_losing_fields(source, expected):
    """正常及可修复的输出保留报告和风险数组，括号出现在文字内不影响边界。"""
    parsed, snippet = chain._parse_json_with_repair(source)

    assert parsed == expected
    assert snippet in source


@pytest.mark.parametrize("source", ["", "无法生成报告", '{"other":"value"}', '{"chat_reply":'])
def test_parse_json_reports_unusable_response(source):
    """没有目标 JSON 或没有闭合的输出明确返回解析失败。"""
    assert chain._parse_json_with_repair(source) == (None, None)


@pytest.mark.parametrize(
    "reply",
    [
        "# 合同审查报告\n\n**原文：** 租金按月支付。\n\n**建议：** 明确日期。",
        '引号："合同"；制表符：\t；换行：\n；路径：C:\\contracts\\rent.txt',
        "Unicode：合同条款，风险标记🔴",
        "",
    ],
)
@pytest.mark.parametrize("ensure_ascii", [False, True])
def test_extract_chat_reply_decodes_json_escapes(reply, ensure_ascii):
    """标准 JSON 转义（含中文与代理对）都还原为原报告文本。"""
    source = json.dumps({"chat_reply": reply, "risk_points": []}, ensure_ascii=ensure_ascii)

    assert chain._extract_chat_reply_from_json(source) == reply


def test_extract_chat_reply_supports_repaired_json():
    """修复缺逗号后流式输出的报告应与解析结果一致。"""
    source = '{"chat_reply":"审查建议" "risk_points":[]}'

    assert chain._extract_chat_reply_from_json(source) == "审查建议"


@pytest.mark.parametrize("source", ['{"risk_points":[]}', '{"chat_reply":null}', "not-json"])
def test_extract_chat_reply_returns_none_without_text(source):
    """不存在文本报告时返回 None，不将其他字段误当报告。"""
    assert chain._extract_chat_reply_from_json(source) is None


@pytest.mark.parametrize(
    "source",
    [
        "# 报告\n\n第一段\n\n第二段",
        "```json\n# 报告\n\n第一段\n\n第二段\n```",
        "  ```\n# 报告\n\n第一段\n\n第二段\n```  ",
    ],
)
def test_normalize_chat_reply_preserves_paragraph_breaks(source):
    """清理外层代码围栏时保留报告中的段落空行。"""
    assert chain._normalize_chat_reply(source) == "# 报告\n\n第一段\n\n第二段"


def test_post_process_risks_preserves_risk_metadata():
    """定位引用时保留等级及说明，并兼容已存在的 quote 和未命中短语。"""
    risks = [
        {"key_phrase": "甲方应退还押金", "level": "medium", "bubble_text": "明确返还日期"},
        {"quote": "原有引用", "level": "low", "bubble_text": "原有建议"},
        {"key_phrase": "未匹配的文字", "level": "high", "bubble_text": "需人工核对"},
    ]
    original_risks = [dict(risk) for risk in risks]

    result = chain._post_process_risks("甲方应退还\n押金。", risks)

    assert result[0] == {**original_risks[0], "quote": "甲方应退还\n押金"}
    assert result[1] == original_risks[1]
    assert result[2] == {**original_risks[2], "quote": "未匹配的文字"}


async def test_non_stream_contract_analysis_uses_json_repair(monkeypatch):
    """非流式审查也应容忍缺失逗号，与流式接口使用同一解析规则。"""
    agent = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value={
                "messages": [AIMessage(content='{"chat_reply":"报告" "risk_points":[]}')],
            }
        )
    )
    monkeypatch.setattr(chain, "contract_agent", agent)

    result = await chain.run_contract_analysis("租金按月支付。")

    assert result == {"raw_text": "租金按月支付。", "risk_points": [], "chat_reply": "报告"}


async def test_non_stream_contract_analysis_rejects_missing_json(monkeypatch):
    """无可用 JSON 时抛出可供路由处理的异常。"""
    agent = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value={
                "messages": [AIMessage(content="无法输出报告")],
            }
        )
    )
    monkeypatch.setattr(chain, "contract_agent", agent)

    with pytest.raises(ValueError, match="审查报告格式异常"):
        await chain.run_contract_analysis("租金按月支付。")


@pytest.mark.parametrize("needs_repair", [False, True])
async def test_stream_contract_tokens_match_final_report(monkeypatch, needs_repair):
    """真实流处理中的逐字文本与结束帧一致，包括 Unicode 转义和 JSON 修复。"""
    reply = "# 报告\n\n建议明确付款日期，并补充 {条款}。"
    source = json.dumps({"chat_reply": reply, "risk_points": []}, ensure_ascii=True)
    if needs_repair:
        source = source.replace(', "risk_points"', ' "risk_points"')

    async def generate(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": SimpleNamespace(content=source)},
        }

    monkeypatch.setattr(chain, "contract_agent", SimpleNamespace(astream_events=generate))
    monkeypatch.setattr(chain.asyncio, "sleep", AsyncMock())

    events = [event async for event in chain.run_contract_analysis_stream("合同原文")]

    assert "".join(event["content"] for event in events if event["type"] == "token") == reply
    assert events[-1] == {
        "type": "done",
        "raw_text": "合同原文",
        "risk_points": [],
        "chat_reply": reply,
    }


async def test_stream_contract_reports_unusable_response(monkeypatch):
    """流式审查无法解析结果时发出错误帧，不发正常结束帧。"""

    async def generate(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": SimpleNamespace(content="无法生成结构化报告")},
        }

    monkeypatch.setattr(chain, "contract_agent", SimpleNamespace(astream_events=generate))
    monkeypatch.setattr(chain.asyncio, "sleep", AsyncMock())

    events = [event async for event in chain.run_contract_analysis_stream("合同原文")]

    assert events[-1]["type"] == "error"
    assert all(event["type"] != "done" for event in events)
