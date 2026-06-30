"""
Agent dialog chain: legal QA + contract review
"""
import json, re
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage

from app.agent.tools import AGENT_TOOLS
from app.core.config import get_settings

settings = get_settings()

llm = ChatOpenAI(
    model="deepseek-chat",
    api_key=settings.deepseek_api_key,
    base_url=settings.deepseek_base_url,
    temperature=0.3,
    timeout=120,
)

LEGAL_SYSTEM_PROMPT = (
    "你是专业法律AI助手。用户会提出法律问题，你必须先调用工具检索相关法条，再基于检索结果回答。"
    "工作流程："
    "1. 收到用户问题后，第一时间调用 search_laws 检索本地法律知识库"
    "2. 若本地结果不足，可额外调用 search_web 联网补充"
    "3. 综合检索结果，给出准确的法律建议，引用具体法条出处"
    "回答要求：使用 Markdown 格式，分点列举，引用法律名称和条款号。"
    "如果问题超出法律范畴，说明无法提供建议。"
)

chat_agent = create_agent(
    model=llm,
    tools=AGENT_TOOLS,
    system_prompt=LEGAL_SYSTEM_PROMPT,
)


async def run_chat(query: str, history: list | None = None) -> dict:
    """Legal QA: returns {"reply": str, "sources": list}"""
    messages = []
    for h in (history or []):
        if h.get("role") == "user":
            messages.append(HumanMessage(content=h["content"]))
        elif h.get("role") == "assistant":
            messages.append(AIMessage(content=h["content"]))
    messages.append(HumanMessage(content=query))
    result = await chat_agent.ainvoke({"messages": messages})
    all_msgs = result["messages"]
    reply = ""
    sources = []
    for m in all_msgs:
        if isinstance(m, AIMessage) and m.content:
            reply = m.content
        if getattr(m, "name", None) == "search_laws" and hasattr(m, "content"):
            sources.append(m.content[:200])
    return {"reply": reply, "sources": sources[:5]}


CONTRACT_SYSTEM_PROMPT = (
    "你是专业合同审查AI。用户会发送一份合同文本，"
    "你需要逐条分析其中的风险条款，输出严格的 JSON 格式。"
    "输出 JSON 格式如下（不要包含其他任何内容）："
    "输出 JSON 格式如下（不要包含任何其他内容）："
    "{\"chat_reply\": \"Markdown格式的总体审查报告\", \"risk_points\": [{\"quote\": \"原句引用\", \"level\": \"high|medium|low\", \"bubble_text\": \"法律分析和修改建议\"}]}"
    "审查标准："
    "high = 违反法律强制性规定、显失公平的霸王条款；"
    "medium = 权利义务不对等、表述模糊可能引发争议；"
    "low = 建议优化的常规条款。"
    "chat_reply 中需包含总体评估和逐条分析，引用相关法条。"
)


async def run_contract_analysis(raw_text: str) -> dict:
    """Contract review returning structured result"""
    messages = [
        SystemMessage(content=CONTRACT_SYSTEM_PROMPT),
        HumanMessage(content=f"请审查以下合同文本：\n\n{raw_text}"),
    ]
    response = await llm.ainvoke(messages)
    raw = response.content.strip()
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        raise ValueError(f"JSON not found in: {raw[:300]}")
    data = json.loads(m.group())
    return {
        "raw_text": raw_text,
        "risk_points": data.get("risk_points", []),
        "chat_reply": data.get("chat_reply", ""),
    }
