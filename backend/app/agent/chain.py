"""
Agent dialog chain: legal QA + contract review
"""
import json, re, asyncio
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage

from app.agent.tools import AGENT_TOOLS
from app.core.config import get_settings

settings = get_settings()
NL = chr(10)


def _extract_chinese(s): return re.sub(r"[^一-龥]", "", s)

def fuzzy_match(raw_text, key_phrase):
    pc = _extract_chinese(key_phrase)
    tc = _extract_chinese(raw_text)
    idx = tc.find(pc)
    if idx == -1: return None
    cnt = 0; start = end = -1
    for i, ch in enumerate(raw_text):
        if "一" <= ch <= "龥":
            if cnt == idx: start = i
            if cnt == idx + len(pc) - 1: end = i + 1; break
            cnt += 1
    if start >= 0 and end > start: return raw_text[start:end]
    return None

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

    print(f"\n{chr(61)*60}")
    print(f"[Chat] user: {query[:150]}")
    print(f"{chr(61)*60}")

    result = await chat_agent.ainvoke({"messages": messages})
    all_msgs = result["messages"]

    # tool call trace
    for m in all_msgs:
        name = getattr(m, "name", "")
        if isinstance(m, ToolMessage):
            snippet = str(m.content)[:500].replace(NL, " ")
            print(f"  [{name}] result: {snippet}")
        elif isinstance(m, AIMessage) and hasattr(m, "tool_calls") and m.tool_calls:
            for tc in m.tool_calls:
                args = tc.get("args", {})
                q = args.get("query", args.get("text", str(args)[:80]))
                print(f"  [LLM call -> {tc.get('name', '?')}] {q}")

    reply = ""
    sources = []
    for m in all_msgs:
        if isinstance(m, AIMessage) and m.content:
            reply = m.content
        name = getattr(m, "name", "")
        if name and hasattr(m, "content") and m.content:
            sources.append({"tool": name, "snippet": str(m.content)[:200]})

    print(f"  [reply] {reply[:200]}...")
    return {"reply": reply, "sources": sources[:5]}

# -*- coding: utf-8 -*-

async def run_chat_stream(query, history=None):
    """Legal QA streaming: yields SSE dicts"""
    messages = []
    for h in (history or []):
        if h.get("role") == "user":
            messages.append(HumanMessage(content=h["content"]))
        elif h.get("role") == "assistant":
            messages.append(AIMessage(content=h["content"]))
    messages.append(HumanMessage(content=query))
    print(f"\n{chr(61)*60}")
    print(f"[Chat Stream] user: {query[:150]}")
    print(f"{chr(61)*60}")
    pending = ""
    tool_called = False
    async for event in chat_agent.astream_events({"messages": messages}, version="v2"):
        kind = event["event"]
        if kind == "on_tool_start":
            tool_called = True
            if pending.strip():
                print(f"  [Stream] reasoning flush: {pending[:80]}...")
                yield {"type": "thinking_reasoning", "content": pending.strip()}
                pending = ""
            tool_name = event.get("name", "unknown")
            label_map = {"search_laws": "search_laws", "search_web": "search_web", "search_legal": "search_legal", "verify_legal": "verify_legal"}
            label = label_map.get(tool_name, tool_name)
            print(f"  [Stream] thinking: {label}")
            yield {"type": "thinking", "label": label}
        elif kind == "on_tool_end":
            if pending.strip():
                print(f"  [Stream] reasoning flush: {pending[:80]}...")
                yield {"type": "thinking_reasoning", "content": pending.strip()}
                pending = ""
            tool_name = event.get("name", "unknown")
            output = event["data"].get("output", "")
            if hasattr(output, "content"):
                output = str(output.content)
            else:
                output = str(output)
            print(f"  [Stream] tool_done: {tool_name}")
            chunk_size = 30
            for j in range(0, len(output), chunk_size):
                yield {"type": "tool_result_chunk", "tool": tool_name, "content": output[j:j+chunk_size], "first": j == 0}
                await asyncio.sleep(0.02)
            yield {"type": "tool_result_end", "tool": tool_name}
        elif kind == "on_chat_model_stream":
            chunk = event["data"]["chunk"]
            if chunk.content:
                pending += chunk.content
    # Flush final answer in small batches for typing effect
    if pending.strip():
        print(f"  [Stream] final answer: {pending[:80]}...")
        batch_size = 8
        for j in range(0, len(pending), batch_size):
            yield {"type": "token", "content": pending[j:j+batch_size]}
            await asyncio.sleep(0.03)
    print(f"  [Stream] done")
    yield {"type": "done"}
CONTRACT_SYSTEM_PROMPT = (
    "你是专业合同审查AI。用户会发送一份合同文本，你需要逐条分析风险条款。"
    "\n\n工作流程（重要！最多2轮工具调用）："
    "\n1. 用search_laws一次性检索合同涉及的所有法律领域（买卖、违约、仲裁等）"
    "\n2. 若本地结果不足，可再用search_web或search_legal补充一次，不要重复搜索同一主题"
    "\n3. 两轮工具调用后，必须直接输出JSON审查结果"
    "\n\n输出JSON格式（不要包含任何其他内容）："
    "{\"chat_reply\": \"Markdown格式的总体审查报告（对话区显示）\", \"risk_points\": [{\"key_phrase\": \"从合同原文中摘录的关键词句\", \"level\": \"high|medium|low\", \"bubble_text\": \"法律分析和修改建议\"}]}"
    "\n\n重要规则："
    "\n- key_phrase必须从合同原文中逐字摘录，5-20个汉字，用于在原文中定位标记"
    "\n- key_phrase不得改写、润色、调整语序、增减字词"
    "\n- 若合同中有多处相同文字，摘录时适当多取几个字以区分"
    "\n- 如果某条款整体偏高危，key_phrase取该条款的第一句话即可"
    "\n- bubble_text不少于30字，必须包含法条依据和具体修改建议，严禁截断"
    "\n- 必须标注所有等级的风险条款，包括low等级，不得遗漏任何风险点"
    "\n- chat_reply使用Markdown，包含总体评估和逐条分析，风险等级用🔴🟡⚪标记"
    "\n\n审查标准："
    "high = 违反法律强制性规定、显失公平的霸王条款；"
    "medium = 权利义务不对等、表述模糊可能引发争议；"
    "low = 建议优化的常规条款。"
)
contract_agent = create_agent(
    model=llm,
    tools=AGENT_TOOLS,
    system_prompt=CONTRACT_SYSTEM_PROMPT,
)


async def run_contract_analysis(raw_text: str) -> dict:
    """Contract review returning structured result"""
    query = f"请审查以下合同文本：\n\n{raw_text}"

    print(f"\n{chr(61)*60}")
    print(f"[Contract] review request, text length: {len(raw_text)}")
    print(f"{chr(61)*60}")

    messages = [HumanMessage(content=query)]
    result = await contract_agent.ainvoke({"messages": messages}, config={"recursion_limit": 12})
    all_msgs = result["messages"]

    # tool call trace
    for m in all_msgs:
        name = getattr(m, "name", "")
        if isinstance(m, ToolMessage):
            snippet = str(m.content)[:500].replace(NL, " ")
            print(f"  [{name}] result: {snippet}")
        elif isinstance(m, AIMessage) and hasattr(m, "tool_calls") and m.tool_calls:
            for tc in m.tool_calls:
                args = tc.get("args", {})
                q = args.get("query", args.get("text", str(args)[:80]))
                print(f"  [LLM call -> {tc.get('name', '?')}] {q}")

    reply = ""
    for m in all_msgs:
        if isinstance(m, AIMessage) and m.content:
            reply = m.content

    m = re.search(r"\{[\s\S]*\}", reply)
    if not m:
        raise ValueError(f"JSON not found in agent response: {reply[:300]}")
    data = json.loads(m.group())

    # Post-process: match key_phrase against raw_text to find exact quote
    risk_points = data.get("risk_points", [])
    for i, rp in enumerate(risk_points):
        kp = rp.get("key_phrase", "")
        if kp:
            matched = fuzzy_match(raw_text, kp)
            if matched:
                rp["quote"] = matched
            else:
                print(f"  [contract] WARN: key_phrase not matched: {kp[:50]}")
                rp["quote"] = kp
        elif rp.get("quote"):
            pass
        else:
            rp["quote"] = ""

    print(f"  [contract] risks found: {len(risk_points)}")

    return {
        "raw_text": raw_text,
        "risk_points": risk_points,
        "chat_reply": data.get("chat_reply", ""),
    }

async def run_contract_analysis_stream(raw_text):
    """Contract review streaming: yields SSE dicts"""
    query = f"请审查以下合同文本：\n\n{raw_text}"
    print(f"\n{'='*60}")
    print(f"[Contract Stream] review request, text length: {len(raw_text)}")
    print(f"{'='*60}")
    messages = [HumanMessage(content=query)]
    full_reply = ""
    pending = ""
    flushed_pos = 0
    async for event in contract_agent.astream_events({"messages": messages}, version="v2", config={"recursion_limit": 12}):
        kind = event["event"]
        if kind == "on_tool_start":
            if pending.strip():
                print(f"  [Stream] reasoning flush: {pending[:80]}...")
                yield {"type": "thinking_reasoning", "content": pending.strip()}
                pending = ""
                flushed_pos = len(full_reply)
            tool_name = event.get("name", "unknown")
            label_map = {"search_laws": "search_laws", "search_web": "search_web", "search_legal": "search_legal", "verify_legal": "verify_legal"}
            label = label_map.get(tool_name, tool_name)
            print(f"  [Stream] thinking: {label}")
            yield {"type": "thinking", "label": label}
        elif kind == "on_tool_end":
            if pending.strip():
                print(f"  [Stream] reasoning flush: {pending[:80]}...")
                yield {"type": "thinking_reasoning", "content": pending.strip()}
                pending = ""
                flushed_pos = len(full_reply)
            tool_name = event.get("name", "unknown")
            output = event["data"].get("output", "")
            if hasattr(output, "content"):
                output = str(output.content)
            else:
                output = str(output)
            print(f"  [Stream] tool_done: {tool_name}")
            # Stream tool result in chunks for progressive display
            chunk_size = 30
            for j in range(0, len(output), chunk_size):
                yield {"type": "tool_result_chunk", "tool": tool_name, "content": output[j:j+chunk_size], "first": j == 0}
                await asyncio.sleep(0.03)
            yield {"type": "tool_result_end", "tool": tool_name}
        elif kind == "on_chat_model_stream":
            chunk = event["data"]["chunk"]
            if chunk.content:
                full_reply += chunk.content
                pending += chunk.content
                # Stream reasoning tokens unless JSON has started
                if not (re.search(r'\{\s*"', full_reply) or full_reply.rstrip().endswith('{')):
                    for ch in chunk.content:
                        yield {"type": "thinking_reasoning_token", "content": ch}
                        await asyncio.sleep(0.01)
    # Extract JSON and flush final reasoning
    print(f"  [Stream] final pending len: {len(pending)}")
    # Flush final reasoning (text between last tool end and JSON start)
    m = re.search(r'\{\s*"chat_reply"|\{\s*"risk_points"', full_reply)
    if m:
        reasoning_tail = full_reply[flushed_pos:m.start()].strip()
        reasoning_tail = re.sub(r'```\w*\s*\n?\s*$', '', reasoning_tail).strip()
        reasoning_tail = re.sub(r'```$', '', reasoning_tail).strip()
        if reasoning_tail:
            print(f"  [Stream] reasoning flush (final): {reasoning_tail[:80]}...")
            yield {"type": "thinking_reasoning", "content": reasoning_tail}
    # Find JSON start by locating {"chat_reply" (not just first { which may be in reasoning)
    m = re.search(r'\{\s*"chat_reply"', full_reply)
    if not m:
        m = re.search(r'\{\s*"risk_points"', full_reply)
    if not m:
        yield {"type": "error", "message": "JSON not found in agent response"}
        return
    start_json = m.start()
    # Parse JSON with raw_decode (handles braces inside string values)
    try:
        decoder = json.JSONDecoder()
        data, end_idx = decoder.raw_decode(full_reply[start_json:])
    except json.JSONDecodeError as e:
        print(f"  [Stream] raw_decode error: {e}")
        yield {"type": "error", "message": f"JSON parse error: {e}"}
        return
    json_str = full_reply[start_json:start_json + end_idx]
    print(f"  [Stream] json parsed OK, len={len(json_str)}")
    # Stream chat_reply progressively (flexible whitespace around colon)
    m = re.search(r'"chat_reply"\s*:\s*"', json_str)
    if m:
        print(f"  [Stream] chat_reply marker found at {m.start()}, streaming...")  
        i = m.end()
        batch = ""
        while i < len(json_str):
            ch = json_str[i]
            if ch == '\\' and i + 1 < len(json_str):
                nc = json_str[i + 1]
                if nc == 'n': batch += '\n'
                elif nc == 't': batch += '\t'
                elif nc == '\\': batch += '\\'
                elif nc == '"': batch += '"'
                elif nc == 'u': i += 5
                else: batch += nc
                i += 2
            elif ch == '"':
                break
            else:
                batch += ch
                i += 1
            if len(batch) >= 8:
                yield {"type": "token", "content": batch}
                batch = ""
                await asyncio.sleep(0.03)
        if batch:
            yield {"type": "token", "content": batch}
        print(f"  [Stream] chat_reply streaming done")
    else:
        print("  [Stream] WARN: chat_reply marker not found in JSON")
    # Post-process risk_points
    risk_points = data.get("risk_points", [])
    for i, rp in enumerate(risk_points):
        kp = rp.get("key_phrase", "")
        if kp:
            matched = fuzzy_match(raw_text, kp)
            if matched: rp["quote"] = matched
            else:
                print(f"  [contract stream] WARN: key_phrase not matched: {kp[:50]}")
                rp["quote"] = kp
        elif rp.get("quote"): pass
        else: rp["quote"] = ""
    print(f"  [contract stream] risks found: {len(risk_points)}")
    chat_reply = data.get("chat_reply", "")
    chat_reply = chat_reply.strip()
    chat_reply = re.sub(r"```json\s*\n?", "", chat_reply)
    chat_reply = re.sub(r"\n?\s*```\s*\n?", "\n", chat_reply)
    chat_reply = chat_reply.strip()
    yield {"type": "done", "raw_text": raw_text, "risk_points": risk_points, "chat_reply": chat_reply}
