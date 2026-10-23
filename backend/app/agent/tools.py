"""
Agent 工具集：本地法律检索 + 元典智库 + 联网搜索 + 幻觉校验
"""

import json
import logging
import re

import httpx
from langchain_core.tools import tool
from langchain_tavily._utilities import TavilySearchAPIWrapper

from app.agent.retriever import get_retriever
from app.core.config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)

# ---- 共享 httpx 客户端（连接池复用，避免端口耗尽） ----
_httpx_client = httpx.Client(
    timeout=30,
    limits=httpx.Limits(max_keepalive_connections=5, max_connections=20),
)

# 法条号转换工具
_CN_NUMS = "零一二三四五六七八九"


def _arabic_to_chinese(num_str):
    """将 0 至 9999 转为中文数词，不支持的输入保持原值。"""
    try:
        number = int(num_str)
    except (TypeError, ValueError):
        return num_str
    if not 0 <= number < 10000:
        return num_str
    if number == 0:
        return _CN_NUMS[0]

    digits = str(number)
    units = ("", "十", "百", "千")
    parts = []
    for position, character in enumerate(digits):
        digit = int(character)
        if digit:
            parts.append(_CN_NUMS[digit] + units[len(digits) - position - 1])
        elif parts[-1] != "零":
            parts.append("零")
    result = "".join(parts).rstrip("零")
    return result[1:] if result.startswith("一十") else result


_LAW_ALIASES = {
    "民法典": "中华人民共和国民法典",
    "刑法": "中华人民共和国刑法",
    "劳动法": "中华人民共和国劳动法",
    "劳动合同法": "中华人民共和国劳动合同法",
    "公司法": "中华人民共和国公司法",
    "治安管理处罚法": "中华人民共和国治安管理处罚法",
    "消费者权益保护法": "中华人民共和国消费者权益保护法",
    "著作权法": "中华人民共和国著作权法",
    "道路交通安全法": "中华人民共和国道路交通安全法",
    "个人信息保护法": "中华人民共和国个人信息保护法",
    "反家庭暴力法": "中华人民共和国反家庭暴力法",
    "反电信网络诈骗法": "中华人民共和国反电信网络诈骗法",
}

_LAW_NAME_KEYWORDS = {
    **{alias: alias for alias in _LAW_ALIASES},
    **{full_name: alias for alias, full_name in _LAW_ALIASES.items()},
}
_LAW_NAME_PATTERN = re.compile(
    r"《([^》]+)》|"
    + "|".join(re.escape(name) for name in sorted(_LAW_NAME_KEYWORDS, key=len, reverse=True))
)


def _extract_article_numbers(query):
    """逐处提取法条号并关联前文法律名，同一法律的连续条号沿用上下文。"""
    results = []
    law_keyword = None
    previous_end = 0
    for article_match in re.finditer(r"第([零一二三四五六七八九十百千万\d]+)条", query):
        prefix = query[previous_end : article_match.start()]
        for law_match in _LAW_NAME_PATTERN.finditer(prefix):
            candidate = (law_match.group(1) or law_match.group(0)).strip()
            law_keyword = _LAW_NAME_KEYWORDS.get(candidate)
        number = article_match.group(1)
        article_cn = "第" + (_arabic_to_chinese(number) if number.isdigit() else number) + "条"
        results.append((law_keyword, article_cn))
        previous_end = article_match.end()
    return results


@tool
def search_laws(query: str) -> str:
    """检索本地法律知识库（向量 + BM25 + 精确法条匹配三路召回）。"""
    retriever = get_retriever()
    vector_results = retriever.search(query, top_k=8)
    bm25_results = retriever.search_bm25(query, top_k=8)
    exact_results = []
    article_nums = _extract_article_numbers(query)
    if article_nums:
        try:
            exact_results = retriever.search_by_articles(article_nums, _LAW_ALIASES)
        except Exception:
            logger.warning("精确法条检索失败，继续使用 BM25 与向量结果", exc_info=True)
    seen = set()
    all_results = []
    for r in exact_results:
        key = (r["law"], r.get("article", ""))
        if key not in seen:
            seen.add(key)
            all_results.append(r)
    for r in bm25_results:
        key = (r["law"], r.get("article", ""))
        if key not in seen:
            seen.add(key)
            all_results.append(r)
    for r in vector_results:
        key = (r["law"], r.get("article", ""))
        if key not in seen:
            seen.add(key)
            all_results.append(r)
    logger.debug(
        "本地法条召回完成：精确=%d，BM25=%d，向量=%d，去重后=%d",
        len(exact_results),
        len(bm25_results),
        len(vector_results),
        len(all_results),
    )
    return retriever.format_results(all_results)


# ============================================================
# 工具 2：元典智库专业法律检索（语义 + 关键词双路召回）
# ============================================================

YUANDIAN_MCP = "https://open.chineselaw.com/mcp/law/stream"
YUANDIAN_REST = "https://open.chineselaw.com/open"


def _yd_rest(endpoint: str, body: dict) -> dict:
    """调用元典智库 REST API 接口"""
    r = _httpx_client.post(
        f"{YUANDIAN_REST}/{endpoint}",
        json=body,
        headers={
            "X-API-Key": settings.yuandian_api_key,
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    r.raise_for_status()
    return r.json()


def _yd_mcp(tool_name: str, arguments: dict) -> dict:
    """调用元典智库 MCP JSON-RPC 接口"""
    import uuid

    r = _httpx_client.post(
        YUANDIAN_MCP,
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
            "id": str(uuid.uuid4())[:8],
        },
        headers={
            "Authorization": f"Bearer {settings.yuandian_api_key}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        },
    )
    r.raise_for_status()
    return r.json()


def _format_fatiao(items: list, max_items: int = 5) -> str:
    """将元典智库法条结果格式化为可读文本"""
    parts = []
    for i, f in enumerate(items[:max_items], 1):
        title = f.get("fgtitle", f.get("fgmc", ""))
        if isinstance(title, list):
            title = title[0] if title else ""
        num = f.get("num", f.get("ft_num", ""))
        content = f.get("content", f.get("llm_content", ""))[:300]
        sxx = f.get("sxx", "")
        effect = f.get("effect1", f.get("xljb_1", ""))
        url = f.get("url", "")
        meta = f" | 时效性:{sxx}" if sxx else ""
        meta += f" | 效力:{effect}" if effect else ""
        line = f"[{i}] {title} {num}{meta}"
        if content:
            line += f"\n{content}"
        if url:
            line += f"\n来源: {url}"
        parts.append(line)
    return "\n\n".join(parts)


@tool
def search_legal(query: str) -> str:
    """搜索元典智库专业法律数据库。先语义检索，不足时补充关键词检索。"""
    if not settings.yuandian_api_key or "your-api-key" in settings.yuandian_api_key:
        return "元典智库 API Key 未配置。"

    results = []
    try:
        resp = _yd_rest(
            "law_vector_search",
            {
                "query": query,
                "rewrite_flag": True,
                "return_num": 5,
            },
        )
        if resp.get("code") == 201:
            results = resp.get("extra", {}).get("fatiao", [])
    except Exception:
        logger.warning("元典智库语义检索失败，尝试关键词检索", exc_info=True)

    if len(results) < 3:
        try:
            resp = _yd_mcp(
                "yuandian_rh_ft_search",
                {
                    "keyword": query,
                    "top_k": 5,
                    "sxx": "现行有效",
                },
            )
            content = resp.get("result", {}).get("content", [])
            if content:
                data = json.loads(content[0]["text"])
                extra = data.get("dataPreview", {}).get("data", [])
                existing = {f.get("ftid", "") for f in results}
                for item in extra:
                    if item.get("id", "") not in existing:
                        results.append(item)
        except Exception:
            logger.warning("元典智库关键词检索失败，保留已有结果", exc_info=True)

    if not results:
        return "元典智库未检索到相关结果。"
    return _format_fatiao(results)


# ============================================================
# 工具 3：法律幻觉校验
# ============================================================


@tool
def verify_legal(text: str) -> str:
    """校验一段法律文本中的法条引用是否真实、时效性是否正确。
    当 LLM 生成法律建议后，可用此工具自查引用准确性。"""
    if not settings.yuandian_api_key or "your-api-key" in settings.yuandian_api_key:
        return "元典智库 API Key 未配置。"

    try:
        resp = _yd_rest("hall_detect", {"text": text[:2000]})
        regs = resp.get("regulations", [])
        if not regs:
            return "未检测到法条引用，或校验服务暂不可用。"

        parts = []
        for r in regs[:10]:
            name = r.get("name", "")
            clause = r.get("clause", "")
            sc = r.get("semantic_compare", {})
            conclusion = sc.get("结论", "?")
            valid = r.get("validity_status", "")
            line = f"- {name} {clause}: 语义={conclusion}"
            if valid:
                line += f" 时效性={valid}"
            if r.get("source_no_specific_clause"):
                line += " [仅法规名，无具体条号]"
            parts.append(line)
        return "法律引用校验结果:\n" + "\n".join(parts)
    except Exception as e:
        logger.warning("法律引用校验服务异常", exc_info=True)
        return f"法律校验服务异常: {str(e)}"


# ============================================================
# 工具 4：联网搜索（Tavily Search API）
# ============================================================

_tavily = TavilySearchAPIWrapper(tavily_api_key=settings.tavily_api_key)


@tool
def search_web(query: str) -> str:
    """联网搜索（Tavily API），获取最新法律新闻、司法解释与案例。"""
    if not settings.tavily_api_key or "your-api-key" in settings.tavily_api_key:
        return "Tavily Search API Key 未配置。"

    try:
        raw = _tavily.raw_results(
            query=query,
            max_results=3,
            search_depth="basic",
            include_domains=[],
            exclude_domains=[],
            include_answer=False,
            include_raw_content=False,
            include_images=False,
            include_image_descriptions=False,
            include_favicon=False,
            topic="general",
            time_range=None,
            country="",
            auto_parameters=True,
            start_date=None,
            end_date=None,
            include_usage=False,
            exact_match=False,
        )
        results = raw.get("results", [])
        if not results:
            return "未搜索到相关结果。"

        parts = []
        for i, r in enumerate(results, 1):
            title = r.get("title", "")
            url = r.get("url", "")
            content = r.get("content", "")[:300]
            parts.append(f"[{i}] {title}\n{content}\n来源: {url}")
        return "\n\n".join(parts)
    except Exception as e:
        logger.warning("联网搜索服务异常", exc_info=True)
        return f"搜索服务异常: {str(e)}"


# 工具集汇总
# ============================================================

AGENT_TOOLS = [search_laws, search_legal, verify_legal, search_web]
