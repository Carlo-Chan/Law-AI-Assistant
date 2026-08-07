"""
Agent 模块：LangChain 智能体核心逻辑

文件说明：
- tools.py    : 自定义 Tool（本地法条检索、元典智库、Tavily 联网搜索、幻觉校验）
- chain.py    : LangChain 链组装与 Prompt 模板（法律咨询、合同审查，含流式接口）
- retriever.py: ChromaDB 向量检索 + BM25 关键词检索 + 精确法条匹配
"""
