"""
Agent 工具集：本地法律检索 + 元典智库 + 联网搜索 + 幻觉校验
"""
import json, httpx, re
from langchain_core.tools import tool
from langchain_tavily._utilities import TavilySearchAPIWrapper

from app.agent.retriever import get_retriever
from app.core.config import get_settings

settings = get_settings()

# ---- 共享 httpx 客户端（连接池复用，避免端口耗尽） ----
_httpx_client = httpx.Client(
    timeout=30,
    limits=httpx.Limits(max_keepalive_connections=5, max_connections=20),
)

# 法条号转换工具
_CN_NUMS = "零一二三四五六七八九十百千"

def _arabic_to_chinese(num_str):
    """将 '585' 转为 '五百八十五'"""
    try:
        n = int(num_str)
        if n <= 10:
            return _CN_NUMS[n]
        elif n < 100:
            tens = n // 10
            ones = n % 10
            result = (_CN_NUMS[tens] if tens > 1 else "") + "十"
            if ones > 0:
                result += _CN_NUMS[ones]
            if result.startswith("一十"): result = "十" + result[2:]
            return result
        elif n < 1000:
            hundreds = n // 100
            rest = n % 100
            result = _CN_NUMS[hundreds] + "百"
            if rest > 0:
                result += _arabic_to_chinese(str(rest))
            return result
        else:
            return num_str
    except:
        return num_str



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

def _extract_article_numbers(query):
    """extract article numbers with law name, returns [(law_keyword_or_None, article_cn), ...]"""
    results = []
    cn_match = re.findall(r'第([零一二三四五六七八九十百千万\d]+)条', query)
    law_keyword = None
    law_match = re.search(r'《?([^》第]+?)》?\s*第', query)
    if law_match:
        candidate = law_match.group(1).strip()
        if candidate in _LAW_ALIASES:
            law_keyword = candidate
        else:
            for alias in sorted(_LAW_ALIASES, key=lambda x: -len(x)):
                if alias in candidate or candidate in alias:
                    law_keyword = alias
                    break
    for m in cn_match:
        article_cn = "第" + (_arabic_to_chinese(m) if m.isdigit() else m) + "条"
        results.append((law_keyword, article_cn))
    return results
def search_laws(query: str) -> str:
    """search local law database"""
    retriever = get_retriever()
    vector_results = retriever.search(query, top_k=8)
    bm25_results = retriever.search_bm25(query, top_k=8)
    exact_results = []
    article_nums = _extract_article_numbers(query)
    if article_nums:
        try:
            exact_results = retriever.search_by_articles(article_nums, _LAW_ALIASES)
        except Exception:
            pass
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
    return retriever.format_results(all_results)


# ============================================================
# Tool 2: 元典智库专业法律检索（语义 + 关键词双路召回）
# ============================================================

YUANDIAN_MCP = "https://open.chineselaw.com/mcp/law/stream"
YUANDIAN_REST = "https://open.chineselaw.com/open"


def _yd_rest(endpoint: str, body: dict) -> dict:
    """Call 元典 REST API."""
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
    """Call 元典 MCP JSON-RPC."""
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
    """Format fatiao results into readable text."""
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
        resp = _yd_rest("law_vector_search", {
            "query": query,
            "rewrite_flag": True,
            "return_num": 5,
        })
        if resp.get("code") == 201:
            results = resp.get("extra", {}).get("fatiao", [])
    except Exception:
        pass

    if len(results) < 3:
        try:
            resp = _yd_mcp("yuandian_rh_ft_search", {
                "keyword": query,
                "top_k": 5,
                "sxx": "现行有效",
            })
            content = resp.get("result", {}).get("content", [])
            if content:
                data = json.loads(content[0]["text"])
                extra = data.get("dataPreview", {}).get("data", [])
                existing = {f.get("ftid", "") for f in results}
                for item in extra:
                    if item.get("id", "") not in existing:
                        results.append(item)
        except Exception:
            pass

    if not results:
        return "元典智库未检索到相关结果。"
    return _format_fatiao(results)


# ============================================================
# Tool 3: 法律幻觉校验
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
        return f"法律校验服务异常: {str(e)}"


# ============================================================
# Tool 4: 联网搜索（Tavily Search API）
# ============================================================

_tavily = TavilySearchAPIWrapper(tavily_api_key=settings.tavily_api_key)


@tool
def search_web(query: str) -> str:
    """联网搜索，获取最新法律新闻、司法解释与案例。"""
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
        return f"搜索服务异常: {str(e)}"


# 工具集汇总
# ============================================================

AGENT_TOOLS = [search_laws, search_legal, verify_legal, search_web]

