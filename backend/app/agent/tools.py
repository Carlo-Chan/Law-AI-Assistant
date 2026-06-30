"""
Agent 工具集：本地法律检索 + 联网搜索
"""
from langchain_core.tools import tool
from langchain_tavily import TavilySearch
from langchain_tavily._utilities import TavilySearchAPIWrapper

from app.agent.retriever import get_retriever
from app.core.config import get_settings


@tool
def search_laws(query: str) -> str:
    """搜索本地法律知识库，获取相关法律条文原文。"""
    retriever = get_retriever()
    return retriever.search_as_context(query, top_k=5)


settings = get_settings()

tavily_wrapper = TavilySearchAPIWrapper(tavily_api_key=settings.tavily_api_key)

search_web = TavilySearch(
    api_wrapper=tavily_wrapper,
    max_results=3,
).as_tool(
    name="search_web",
    description="联网搜索，获取最新法律新闻、司法解释与案例。",
)


AGENT_TOOLS = [search_laws, search_web]

