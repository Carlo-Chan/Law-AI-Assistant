"""只提取可展示的标准正文，不递归展开推理、工具参数或附件元数据。"""

from langchain_core.messages import AIMessage


def extract_text_content(content: object) -> str:
    """保持字符串和标准文本块的原始顺序与空白，不为分片添加分隔符。"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def extract_final_reply(messages: list) -> str:
    """仅采用末尾非工具调用的助手正文，不回退到历史或过程消息。"""
    if not isinstance(messages, list) or not messages:
        return ""
    final = messages[-1]
    if not isinstance(final, AIMessage) or final.tool_calls:
        return ""
    return extract_text_content(final.content)
