"""
对话链：法律咨询 + 合同审查
"""
import json
import re
import asyncio
from json_repair import repair_json
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage

from app.agent.tools import AGENT_TOOLS
from app.core.config import get_settings

settings = get_settings()
NL = chr(10)


# 提取字符串中的中文字符
def _extract_chinese(s): return re.sub(r"[^一-龥]", "", s)


# 将关键短语与原文进行模糊匹配，返回精确引用文本
def fuzzy_match(raw_text, key_phrase):
    pc = _extract_chinese(key_phrase)
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

chat_agent = create_agent(
    model=llm,
    tools=AGENT_TOOLS,
    system_prompt=LEGAL_SYSTEM_PROMPT,
)


async def run_chat(query: str, history: list | None = None) -> dict:
    """非流式法律咨询，返回完整回复和引用来源"""
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

    # 打印工具调用追踪日志
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


async def run_chat_stream(query, history=None):
    """流式法律咨询，通过 async generator 逐事件产出 SSE 数据"""
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
            label_map = {"search_laws": "search_laws", "search_web": "search_web",
                         "search_legal": "search_legal", "verify_legal": "verify_legal"}
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
    # 将最终回复分批输出，产生打字机效果
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
    "\n**原文：** \"逐字摘录的合同原文\""
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
    '\n- bubble_text: 不少于30字。格式为\"该条款存在XX风险。依据《XX法》第X条，……。建议修改为：……\"，严禁截断。'
    "\n必须标注所有等级的风险条款，包括low等级，不得遗漏任何风险点。"
    "\n\n完整JSON示例（注意risk_points不能为空数组）："
    '{\"chat_reply\": \"# 合同审查报告\\n...\", \"risk_points\": [{\"key_phrase\": \"逐字摘录的合同原文\", \"level\": \"high\", \"bubble_text\": \"该条款存在霸王条款风险。依据《民法典》第X条，……。建议修改为：……\"}]}'
    "\n\n再次强调：risk_points数组必须有内容，不能是空的！有多少个风险点就放多少个元素！"
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

    # 打印工具调用追踪日志
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

    # 后处理：将 key_phrase 与原文模糊匹配，定位精确引用文本
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
            label_map = {"search_laws": "search_laws", "search_web": "search_web",
                         "search_legal": "search_legal", "verify_legal": "verify_legal"}
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
            # 逐块流式传输工具返回结果，实现渐进式展示
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
                # 流式输出推理思考文字，除非 JSON 已经开始
                if not (re.search(r'\{\s*"', full_reply) or full_reply.rstrip().endswith('{')):
                    for ch in chunk.content:
                        yield {"type": "thinking_reasoning_token", "content": ch}
                        await asyncio.sleep(0.01)
    # 提取 JSON 并输出最后的推理文字
    print(f"  [Stream] final pending len: {len(pending)}")
    # 输出最终推理文字（最后一个工具调用结束到 JSON 开始之间的文本）
    m = re.search(r'\{\s*"chat_reply"|\{\s*"risk_points"', full_reply)
    if m:
        reasoning_tail = full_reply[flushed_pos:m.start()].strip()
        reasoning_tail = re.sub(r'```\w*\s*\n?\s*$', '',
                                reasoning_tail).strip()
        reasoning_tail = re.sub(r'```$', '', reasoning_tail).strip()
        if reasoning_tail:
            print(
                f"  [Stream] reasoning flush (final): {reasoning_tail[:80]}...")
            yield {"type": "thinking_reasoning", "content": reasoning_tail}
    # 定位 JSON 起始位置：查找 {"chat_reply" 而非第一个 {（推理文字中也可能包含 {）
    m = re.search(r'\{\s*"chat_reply"', full_reply)
    if not m:
        m = re.search(r'\{\s*"risk_points"', full_reply)
    if not m:
        yield {"type": "error", "message": "JSON not found in agent response"}
        return
    start_json = m.start()
    # 解析 JSON：先用 raw_decode，失败后用 json-repair 容错修复
    json_candidate = full_reply[start_json:]
    data = None
    end_idx = 0
    # 方案1：直接 raw_decode
    try:
        decoder = json.JSONDecoder()
        data, end_idx = decoder.raw_decode(json_candidate)
    except json.JSONDecodeError:
        pass
    # 方案2：json-repair 容错（处理未转义字符、缺失逗号等问题）
    if data is None:
        try:
            # 定位 JSON 边界（从第一个 { 到匹配的 }）
            brace_depth = 0
            close_idx = -1
            for i, ch in enumerate(json_candidate):
                if ch == '{':
                    brace_depth += 1
                elif ch == '}':
                    brace_depth -= 1
                    if brace_depth == 0:
                        close_idx = i + 1
                        break
            if close_idx > 0:
                snippet = json_candidate[:close_idx]
                repaired = repair_json(snippet)
                data = json.loads(repaired)
                end_idx = close_idx
        except Exception:
            pass
    if data is None:
        snippet = json_candidate[:200]
        print(
            f"  [Stream] all parse attempts failed, first 200 chars: {snippet}")
        yield {"type": "error", "message": "JSON parse error: unable to parse agent response"}
        return
    json_str = full_reply[start_json:start_json + end_idx]
    print(f"  [Stream] json parsed OK, len={len(json_str)}")
    # 逐字符流式输出 chat_reply 内容
    m = re.search(r'"chat_reply"\s*:\s*"', json_str)
    if m:
        print(
            f"  [Stream] chat_reply marker found at {m.start()}, streaming...")
        i = m.end()
        batch = ""
        while i < len(json_str):
            ch = json_str[i]
            if ch == '\\' and i + 1 < len(json_str):
                nc = json_str[i + 1]
                if nc == 'n':
                    batch += '\n'
                elif nc == 't':
                    batch += '\t'
                elif nc == '\\':
                    batch += '\\'
                elif nc == '"':
                    batch += '"'
                elif nc == 'u':
                    i += 5
                else:
                    batch += nc
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
    # 后处理风险点：将 key_phrase 与原文模糊匹配
    risk_points = data.get("risk_points", [])
    for i, rp in enumerate(risk_points):
        kp = rp.get("key_phrase", "")
        if kp:
            matched = fuzzy_match(raw_text, kp)
            if matched:
                rp["quote"] = matched
            else:
                print(
                    f"  [contract stream] WARN: key_phrase not matched: {kp[:50]}")
                rp["quote"] = kp
        elif rp.get("quote"):
            pass
        else:
            rp["quote"] = ""
    print(f"  [contract stream] risks found: {len(risk_points)}")
    chat_reply = data.get("chat_reply", "")
    chat_reply = chat_reply.strip()
    chat_reply = re.sub(r"```json\s*\n?", "", chat_reply)
    chat_reply = re.sub(r"\n?\s*```\s*\n?", "\n", chat_reply)
    chat_reply = chat_reply.strip()
    yield {"type": "done", "raw_text": raw_text, "risk_points": risk_points, "chat_reply": chat_reply}
