"""
Agent 工具集：本地法律检索 + 元典智库 + 联网搜索
"""
import json, httpx
from langchain_core.tools import tool
from langchain_tavily import TavilySearch
from langchain_tavily._utilities import TavilySearchAPIWrapper

from app.agent.retriever import get_retriever
from app.core.config import get_settings

settings = get_settings()


# ============================================================
# Tool 1: 本地法律条文检索（ChromaDB RAG）
# ============================================================

@tool
def search_laws(query: str) -> str:
    """搜索本地法律知识库，获取相关法律条文原文。"""
    retriever = get_retriever()
    return retriever.search_as_context(query, top_k=5)


# ============================================================
# Tool 2: 元典智库专业法律检索
# ============================================================

YUANDIAN_URL = "https://open.chineselaw.com/mcp/law/stream"


def _call_yuandian(method: str, arguments: dict) -> dict:
    """Call 元典智库 MCP endpoint via JSON-RPC."""
    import uuid
    headers = {
        "Authorization": f"Bearer {settings.yuandian_api_key}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    body = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {"name": method, "arguments": arguments},
        "id": str(uuid.uuid4())[:8],
    }
    resp = httpx.post(YUANDIAN_URL, json=body, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


@tool
def search_legal(query: str) -> str:
    """搜索元典智库专业法律数据库，获取法律法规原文和司法解释。
    当本地知识库覆盖不足、或需要更权威的法律数据库检索时使用。
    返回匹配的法条内容、所属法规和效力级别。"""
    if not settings.yuandian_api_key or "your-api-key" in settings.yuandian_api_key:
        return "元典智库 API Key 未配置。"

    try:
        result = _call_yuandian("yuandian_rh_ft_search", {
            "keyword": query,
            "top_k": 5,
            "sxx": "现行有效",
        })
        content = result.get("result", {}).get("content", [])
        if not content:
            return "元典智库未检索到相关结果。"

        # Parse first content item
        data = json.loads(content[0]["text"])
        items = data.get("dataPreview", {}).get("data", [])
        if not items:
            return "元典智库未检索到相关结果。"

        parts = []
        for i, item in enumerate(items[:5], 1):
            title = item.get("title", "")
            content_text = item.get("llm_content", item.get("content", ""))[:300]
            url = item.get("url", "")
            line = f"[{i}] {title}"
            if content_text:
                line += f"\n{content_text}"
            if url:
                line += f"\n来源: {url}"
            parts.append(line)
        return "\n\n".join(parts)
    except Exception as e:
        return f"元典智库检索失败: {str(e)}"


# ============================================================
# Tool 3: 联网搜索（Tavily API）
# ============================================================

tavily_wrapper = TavilySearchAPIWrapper(tavily_api_key=settings.tavily_api_key)

search_web = TavilySearch(
    api_wrapper=tavily_wrapper,
    max_results=3,
).as_tool(
    name="search_web",
    description="联网搜索，获取最新法律新闻、司法解释与案例。",
)


# ============================================================
# 工具集汇总
# ============================================================

AGENT_TOOLS = [search_laws, search_legal, search_web]

