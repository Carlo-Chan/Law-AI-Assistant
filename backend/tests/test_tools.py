"""法条检索辅助函数测试：验证中文条号转换与法律名称归属。"""
import pytest

from app.agent.tools import _arabic_to_chinese, _extract_article_numbers


@pytest.mark.parametrize(
    ("number", "expected"),
    [
        ("0", "零"),
        ("1", "一"),
        ("9", "九"),
        ("10", "十"),
        ("11", "十一"),
        ("20", "二十"),
        ("99", "九十九"),
        ("100", "一百"),
        ("101", "一百零一"),
        ("105", "一百零五"),
        ("110", "一百一十"),
        ("111", "一百一十一"),
        ("585", "五百八十五"),
        ("999", "九百九十九"),
        ("1000", "一千"),
        ("1001", "一千零一"),
        ("1005", "一千零五"),
        ("1010", "一千零一十"),
        ("1011", "一千零一十一"),
        ("1100", "一千一百"),
        ("1105", "一千一百零五"),
        ("1110", "一千一百一十"),
        ("1260", "一千二百六十"),
        ("9999", "九千九百九十九"),
    ],
)
def test_arabic_to_chinese_converts_article_number(number, expected):
    """条号使用规范中文数词，保留中间的零和百千位后的一十。"""
    assert _arabic_to_chinese(number) == expected


@pytest.mark.parametrize("value", ["-1", "10000", "not-a-number", "", "3.5"])
def test_arabic_to_chinese_preserves_unsupported_input(value):
    """超出当前转换范围或无法转换的输入保持原值。"""
    assert _arabic_to_chinese(value) == value


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("第620条是什么内容？", [(None, "第六百二十条")]),
        ("请查询第六百二十条", [(None, "第六百二十条")]),
        ("民法典第105条", [("民法典", "第一百零五条")]),
        ("《民法典》第1010条", [("民法典", "第一千零一十条")]),
        ("《民法典》第一千二百六十条", [("民法典", "第一千二百六十条")]),
        ("我想咨询租房问题", []),
        ("", []),
        ("合同共620条", []),
        ("《自定义示例法》第5条", [(None, "第五条")]),
        ("法第10条", [(None, "第十条")]),
        ("《民法典实施细则》第10条", [(None, "第十条")]),
        (
            "《民法典》第585条、第588条",
            [("民法典", "第五百八十五条"), ("民法典", "第五百八十八条")],
        ),
        (
            "《民法典》第101条和《刑法》第110条",
            [("民法典", "第一百零一条"), ("刑法", "第一百一十条")],
        ),
        (
            "第10条与《民法典》第585条",
            [(None, "第十条"), ("民法典", "第五百八十五条")],
        ),
        (
            "《民法典》第585条与《自定义示例法》第5条",
            [("民法典", "第五百八十五条"), (None, "第五条")],
        ),
    ],
)
def test_extract_article_numbers_preserves_law_and_article(query, expected):
    """提取明确条号，逐处关联法律名，同一法律的连续条号保留上下文。"""
    assert _extract_article_numbers(query) == expected


@pytest.mark.parametrize(
    ("alias", "full_name"),
    [
        ("民法典", "中华人民共和国民法典"),
        ("刑法", "中华人民共和国刑法"),
        ("劳动法", "中华人民共和国劳动法"),
        ("劳动合同法", "中华人民共和国劳动合同法"),
        ("公司法", "中华人民共和国公司法"),
        ("治安管理处罚法", "中华人民共和国治安管理处罚法"),
        ("消费者权益保护法", "中华人民共和国消费者权益保护法"),
        ("著作权法", "中华人民共和国著作权法"),
        ("道路交通安全法", "中华人民共和国道路交通安全法"),
        ("个人信息保护法", "中华人民共和国个人信息保护法"),
        ("反家庭暴力法", "中华人民共和国反家庭暴力法"),
        ("反电信网络诈骗法", "中华人民共和国反电信网络诈骗法"),
    ],
)
def test_extract_article_numbers_supports_known_law_names(alias, full_name):
    """配置内法律的简称和完整名称都映射为同一个检索关键词。"""
    expected = [(alias, "第十条")]

    assert _extract_article_numbers(f"《{alias}》第10条") == expected
    assert _extract_article_numbers(f"《{full_name}》第10条") == expected
    assert _extract_article_numbers(f"请问{full_name}第10条是什么？") == expected
