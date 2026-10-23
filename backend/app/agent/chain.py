"""
对话链：法律咨询 + 合同审查

重构要点：
- 抽取 _build_history_messages 消除历史消息构建重复
- 抽取 _log_tool_traces 统一工具调用追踪日志
- 抽取 _batch_yield 通用分批输出
- 抽取 _parse_json_with_repair 统一 JSON 容错解析
- 抽取 _post_process_risks 统一风险点后处理
- 抽取 _flush_pending_reasoning 统一 pending 文本刷新逻辑
- 抽取 _stream_tool_result 统一工具结果分块流式传输
- 抽取 _extract_chat_reply_from_json 统一 chat_reply 提取
- 抽取 _normalize_chat_reply 统一 chat_reply 清理
"""

import asyncio
import json
import logging
import re

from json_repair import repair_json
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai import ChatOpenAI

from app.agent.tools import AGENT_TOOLS
from app.core.config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)
NL = chr(10)

# ============================================================
# 公共工具函数
# ============================================================


def _extract_chinese(s):
    """提取字符串中的中文字符"""
    return re.sub(r"[^一-龥]", "", s)


def fuzzy_match(raw_text, key_phrase):
    """将关键短语与原文进行模糊匹配，返回精确引用文本"""
    if not key_phrase or not key_phrase.strip():
        return None
    if key_phrase in raw_text:
        return key_phrase
    pc = _extract_chinese(key_phrase)
    if not pc:
        return None
    tc = _extract_chinese(raw_text)
    idx = tc.find(pc)
    if idx == -1:
        return None
    cnt = 0
    start = end = -1
    for i, ch in enumerate(raw_text):
        if "一" <= ch <= "龥":
            if cnt == idx:
                start = i
            if cnt == idx + len(pc) - 1:
                end = i + 1
                break
            cnt += 1
    if start >= 0 and end > start:
        return raw_text[start:end]
    return None


def _build_history_messages(history):
    """将前端传来的历史记录转换为 LangChain 消息对象列表"""
    messages = []
    for h in history or []:
        if h.get("role") == "user":
            messages.append(HumanMessage(content=h["content"]))
        elif h.get("role") == "assistant":
            messages.append(AIMessage(content=h["content"]))
    return messages


def _log_tool_traces(all_msgs):
    """记录工具名称及结果长度，不记录工具参数或返回正文。"""
    for m in all_msgs:
        name = getattr(m, "name", "")
        if isinstance(m, ToolMessage):
            logger.debug("工具调用完成：%s，结果长度=%d", name, len(str(m.content)))
        elif isinstance(m, AIMessage) and hasattr(m, "tool_calls") and m.tool_calls:
            for tc in m.tool_calls:
                logger.debug("模型调用工具：%s", tc.get("name", "?"))


async def _batch_yield(text, batch_size=8, delay=0.03):
    """将文本分批输出，产生打字机效果，逐批 yield token 事件"""
    for j in range(0, len(text), batch_size):
        yield {"type": "token", "content": text[j : j + batch_size]}
        await asyncio.sleep(delay)


def _parse_json_with_repair(text):
    """从文本中定位并解析 JSON，支持 raw_decode 和 json-repair 两级容错

    返回 (data, json_str)，解析失败返回 (None, None)
    """
    # 定位 JSON 起始：查找 {"chat_reply" 或 {"risk_points"}
    m = re.search(r'\{\s*"chat_reply"', text)
    if not m:
        m = re.search(r'\{\s*"risk_points"', text)
    if not m:
        return None, None

    start_json = m.start()
    json_candidate = text[start_json:]

    # 方案1：直接 raw_decode
    try:
        decoder = json.JSONDecoder()
        data, end_idx = decoder.raw_decode(json_candidate)
        return data, json_candidate[:end_idx]
    except json.JSONDecodeError:
        logger.debug("审查 JSON 解析失败，尝试格式修复")

    # 方案2：json-repair 容错（处理未转义字符、缺失逗号等）
    try:
        brace_depth = 0
        close_idx = -1
        in_string = False
        escaped = False
        for i, ch in enumerate(json_candidate):
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
            elif ch == '"':
                in_string = True
            elif ch == "{":
                brace_depth += 1
            elif ch == "}":
                brace_depth -= 1
                if brace_depth == 0:
                    close_idx = i + 1
                    break
        if close_idx > 0:
            snippet = json_candidate[:close_idx]
            repaired = repair_json(snippet)
            data = json.loads(repaired)
            logger.debug("审查 JSON 格式修复成功")
            return data, snippet
    except Exception:
        logger.warning("审查 JSON 格式修复失败")

    return None, None


def _post_process_risks(raw_text, risk_points, tag="contract"):
    """后处理风险点：将 key_phrase 与原文模糊匹配，定位精确引用文本"""
    for rp in risk_points:
        kp = rp.get("key_phrase", "")
        if kp:
            matched = fuzzy_match(raw_text, kp)
            if matched:
                rp["quote"] = matched
            else:
                logger.warning("风险引用未匹配原文：模式=%s，引用长度=%d", tag, len(kp))
                rp["quote"] = kp
        elif rp.get("quote"):
            pass
        else:
            rp["quote"] = ""
    return risk_points


def _extract_chat_reply_from_json(json_str):
    """从 JSON 字符串中提取 chat_reply 的原始文本内容（解码转义）

    返回提取的文本字符串，未找到则返回 None
    """
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError:
        data, _ = _parse_json_with_repair(json_str)
    if not isinstance(data, dict):
        return None
    reply = data.get("chat_reply")
    return reply if isinstance(reply, str) else None


async def _stream_tool_result(tool_name, output):
    """将工具返回结果分块流式传输，yield SSE 事件"""
    logger.debug("流式工具调用完成：%s，结果长度=%d", tool_name, len(output))
    chunk_size = 30
    for j in range(0, len(output), chunk_size):
        yield {
            "type": "tool_result_chunk",
            "tool": tool_name,
            "content": output[j : j + chunk_size],
            "first": j == 0,
        }
        await asyncio.sleep(0.02)
    yield {"type": "tool_result_end", "tool": tool_name}


def _flush_pending_reasoning(pending):
    """如果 pending 中有推理文字，返回需要 yield 的事件，并返回清空后的 pending"""
    if pending.strip():
        logger.debug("输出工具调用前推理片段，长度=%d", len(pending))
        return {"type": "thinking_reasoning", "content": pending.strip()}, ""
    return None, pending


def _normalize_chat_reply(text):
    """清理 chat_reply 中的 Markdown 代码块标记"""
    text = text.strip()
    text = re.sub(r"```json\s*\n?", "", text)
    text = re.sub(r"\n?\s*```\s*\n?", "\n", text)
    return text.strip()


# ============================================================
# LLM 与 Agent 初始化
# ============================================================

llm = ChatOpenAI(
    model="deepseek-v4-flash",
    api_key=settings.deepseek_api_key,
    base_url=settings.deepseek_base_url,
    temperature=0.3,
    timeout=120,
    max_tokens=16384,
    extra_body={"thinking": {"type": "disabled"}},
)

LEGAL_SYSTEM_PROMPT = (
    "你是专业法律AI助手。用户会提出法律问题，你必须先调用工具检索相关法条，再基于检索结果回答。"
    "工作流程："
    "1. 收到用户问题后，第一时间调用search_laws检索本地法律知识库"
    "2. 若本地结果不足或未找到相关资料，可额外调用search_web联网或search_legal补充"
    "3. 综合检索结果，给出准确的法律建议，引用具体法条出处"
    "回答要求：使用Markdown格式，分点列举，引用法律名称和条款号。"
    "如果问题超出法律范畴，说明无法提供建议。"
    "简单问候或闲聊时直接回复，不必调用工具。"
    "如果多次检索仍无相关结果，不要反复尝试，直接基于已有法律知识给出回答。"
)

CONTRACT_SYSTEM_PROMPT = (
    "你是专业合同审查AI。用户会发送一份合同文本，你需要逐条分析风险条款。"
    "\n\n工作流程（最多2轮工具调用）："
    "\n1. 用search_laws一次性检索合同涉及的所有法律领域"
    "\n2. 若本地结果不足或未找到相关资料，可额外调用search_web联网或search_legal补充"
    "\n3. 如果多次检索仍无相关结果，不要反复尝试，直接基于法律常识输出审查意见"
    "\n4. 必须直接输出以下JSON，禁止用 ```json 包裹，严格遵循模板格式要求，禁止输出任何其他文字"
    "\n\n你的输出是一个JSON对象，包含chat_reply和risk_points两个字段。两者必须同时有内容，缺一不可！"
    "\n\n=== chat_reply字段（Markdown报告）==="
    "\n套用以下模板："
    "\n# 合同审查报告"
    "\n\n## 总体评估"
    "\n本合同共X条，存在**Y个风险点**（🔴高危X个、🟡中危X个、⚪低危X个）。（一句话定性评价）"
    "\n\n---"
    "\n\n## 逐条风险分析"
    "\n\n### 🔴 风险点一：条款名称（第X条）"
    '\n**原文：** "逐字摘录的合同原文"'
    "\n\n**分析：** 法律依据与风险说明"
    "\n\n**建议修改为：** 具体修改方案"
    "\n\n### 🟡 风险点二：..."
    "\n\n### ⚪ 风险点三：..."
    "\n\n---"
    "\n\n## 审查结论"
    "\n\n（1-2句总结建议）"
    "\n风险点按高危→中危→低危排序。"
    "\n\n=== risk_points字段（结构化风险数据，JSON数组）==="
    "\n每个风险点包含三个字段，必须与chat_reply中的风险点一一对应："
    "\n- key_phrase: 从合同原文中逐字摘录（含标点），5-20字。必须能用Ctrl+F精确找到，不得改写、润色、调整语序。若有多处相同文字，多取几个字以区分上下文。"
    "\n- level: high/medium/low（high=违反法律强制性规定、霸王条款；medium=权利义务不对等、表述模糊；low=建议优化的常规条款）"
    '\n- bubble_text: 不少于30字。格式为"该条款存在XX风险。依据《XX法》第X条，……。建议修改为：……"，严禁截断。'
    "\n必须标注所有等级的风险条款，包括low等级，不得遗漏任何风险点。"
    "\n\n完整JSON示例（注意risk_points不能为空数组）："
    '{"chat_reply": "# 合同审查报告\\n...", "risk_points": [{"key_phrase": "逐字摘录的合同原文", "level": "high", "bubble_text": "该条款存在霸王条款风险。依据《民法典》第X条，……。建议修改为：……"}]}'
    "\n\n再次强调：risk_points数组必须有内容，不能是空的！有多少个风险点就放多少个元素！"
)

chat_agent = create_agent(
    model=llm,
    tools=AGENT_TOOLS,
    system_prompt=LEGAL_SYSTEM_PROMPT,
)

contract_agent = create_agent(
    model=llm,
    tools=AGENT_TOOLS,
    system_prompt=CONTRACT_SYSTEM_PROMPT,
)


# ============================================================
# 非流式接口
# ============================================================


async def run_chat(query: str, history: list | None = None) -> dict:
    """非流式法律咨询，返回完整回复和引用来源"""
    messages = _build_history_messages(history)
    messages.append(HumanMessage(content=query))

    logger.info("开始法律咨询：输入长度=%d，历史消息数=%d", len(query), len(history or []))

    result = await chat_agent.ainvoke({"messages": messages})
    all_msgs = result["messages"]

    _log_tool_traces(all_msgs)

    reply = ""
    sources = []
    for m in all_msgs:
        if isinstance(m, AIMessage) and m.content:
            reply = m.content
        name = getattr(m, "name", "")
        if name and hasattr(m, "content") and m.content:
            sources.append({"tool": name, "snippet": str(m.content)[:200]})

    logger.info("法律咨询完成：回复长度=%d，来源数=%d", len(reply), len(sources[:5]))
    return {"reply": reply, "sources": sources[:5]}


async def run_contract_analysis(raw_text: str) -> dict:
    """非流式合同审查，返回结构化结果"""
    query = f"请审查以下合同文本：\n\n{raw_text}"

    logger.info("开始合同审查：原文长度=%d", len(raw_text))

    messages = [HumanMessage(content=query)]
    result = await contract_agent.ainvoke({"messages": messages}, config={"recursion_limit": 12})
    all_msgs = result["messages"]

    _log_tool_traces(all_msgs)

    reply = ""
    for m in all_msgs:
        if isinstance(m, AIMessage) and m.content:
            reply = m.content

    data, _ = _parse_json_with_repair(reply)
    if data is None:
        raise ValueError(f"JSON not found in agent response: {reply[:300]}")

    risk_points = _post_process_risks(raw_text, data.get("risk_points", []))
    logger.info("合同审查完成：风险点数=%d", len(risk_points))

    return {
        "raw_text": raw_text,
        "risk_points": risk_points,
        "chat_reply": data.get("chat_reply", ""),
    }


# ============================================================
# 流式接口
# ============================================================


async def run_chat_stream(query, history=None):
    """流式法律咨询，通过 async generator 逐事件产出 SSE 数据"""
    messages = _build_history_messages(history)
    messages.append(HumanMessage(content=query))
    logger.info("开始流式法律咨询：输入长度=%d，历史消息数=%d", len(query), len(history or []))

    pending = ""
    async for event in chat_agent.astream_events({"messages": messages}, version="v2"):
        kind = event["event"]

        if kind == "on_tool_start":
            evt, pending = _flush_pending_reasoning(pending)
            if evt:
                yield evt
            tool_name = event.get("name", "unknown")
            logger.debug("流式法律咨询调用工具：%s", tool_name)
            yield {"type": "thinking", "label": tool_name}

        elif kind == "on_tool_end":
            evt, pending = _flush_pending_reasoning(pending)
            if evt:
                yield evt
            tool_name = event.get("name", "unknown")
            output = event["data"].get("output", "")
            if hasattr(output, "content"):
                output = str(output.content)
            else:
                output = str(output)
            async for evt in _stream_tool_result(tool_name, output):
                yield evt

        elif kind == "on_chat_model_stream":
            chunk = event["data"]["chunk"]
            if chunk.content:
                pending += chunk.content

    # 将最终回复分批输出，产生打字机效果
    if pending.strip():
        logger.debug("开始输出最终咨询回复，长度=%d", len(pending))
        async for evt in _batch_yield(pending, batch_size=8, delay=0.03):
            yield evt
    logger.info("流式法律咨询完成：回复长度=%d", len(pending))
    yield {"type": "done"}


async def run_contract_analysis_stream(raw_text):
    """流式合同审查，通过 async generator 逐事件产出 SSE 数据"""
    query = f"请审查以下合同文本：\n\n{raw_text}"
    logger.info("开始流式合同审查：原文长度=%d", len(raw_text))
    messages = [HumanMessage(content=query)]

    full_reply = ""
    pending = ""
    flushed_pos = 0

    async for event in contract_agent.astream_events(
        {"messages": messages}, version="v2", config={"recursion_limit": 12}
    ):
        kind = event["event"]

        if kind == "on_tool_start":
            evt, pending = _flush_pending_reasoning(pending)
            if evt:
                yield evt
                flushed_pos = len(full_reply)
            tool_name = event.get("name", "unknown")
            logger.debug("流式合同审查调用工具：%s", tool_name)
            yield {"type": "thinking", "label": tool_name}

        elif kind == "on_tool_end":
            evt, pending = _flush_pending_reasoning(pending)
            if evt:
                yield evt
                flushed_pos = len(full_reply)
            tool_name = event.get("name", "unknown")
            output = event["data"].get("output", "")
            if hasattr(output, "content"):
                output = str(output.content)
            else:
                output = str(output)
            async for evt in _stream_tool_result(tool_name, output):
                yield evt

        elif kind == "on_chat_model_stream":
            chunk = event["data"]["chunk"]
            if chunk.content:
                full_reply += chunk.content
                pending += chunk.content
                # 流式输出推理思考文字，除非 JSON 已经开始
                if not (re.search(r'\{\s*"', full_reply) or full_reply.rstrip().endswith("{")):
                    for ch in chunk.content:
                        yield {"type": "thinking_reasoning_token", "content": ch}
                        await asyncio.sleep(0.01)

    # 输出最终推理文字（最后一个工具调用结束到 JSON 开始之间的文本）
    logger.debug("流式审查输出完毕，待处理文本长度=%d", len(pending))
    m = re.search(r'\{\s*"chat_reply"|\{\s*"risk_points"', full_reply)
    if m:
        reasoning_tail = full_reply[flushed_pos : m.start()].strip()
        reasoning_tail = re.sub(r"```\w*\s*\n?\s*$", "", reasoning_tail).strip()
        reasoning_tail = re.sub(r"```$", "", reasoning_tail).strip()
        if reasoning_tail:
            logger.debug("输出审查末尾推理片段，长度=%d", len(reasoning_tail))
            yield {"type": "thinking_reasoning", "content": reasoning_tail}

    # 解析 JSON（支持两级容错）
    data, json_str = _parse_json_with_repair(full_reply)
    if data is None:
        logger.error("流式合同审查 JSON 解析失败，模型输出长度=%d", len(full_reply))
        yield {"type": "error", "message": "JSON parse error: unable to parse agent response"}
        return

    logger.debug("流式合同审查 JSON 解析成功，长度=%d", len(json_str))

    # 逐字符流式输出 chat_reply 内容
    reply_text = _extract_chat_reply_from_json(json_str)
    if reply_text is not None:
        logger.debug("开始输出审查报告，长度=%d", len(reply_text))
        async for evt in _batch_yield(reply_text, batch_size=8, delay=0.03):
            yield evt
        logger.debug("审查报告流式输出完成")
    else:
        logger.warning("审查 JSON 中缺少文本类型的 chat_reply")

    # 后处理风险点
    risk_points = _post_process_risks(raw_text, data.get("risk_points", []), tag="contract stream")
    logger.info("流式合同审查完成：风险点数=%d", len(risk_points))

    chat_reply = _normalize_chat_reply(data.get("chat_reply", ""))
    yield {
        "type": "done",
        "raw_text": raw_text,
        "risk_points": risk_points,
        "chat_reply": chat_reply,
    }
