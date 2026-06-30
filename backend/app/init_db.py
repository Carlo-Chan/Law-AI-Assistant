"""
初始化 ChromaDB 向量库
从 data/ 目录读取法律 Markdown 文件，切片后灌入 ChromaDB

用法：
    cd backend
    python app/init_db.py

前置条件：
    - 已从 https://github.com/lawtext/laws 下载法律文本放入 data/ 目录
    - 已设置 DEEPSEEK_API_KEY 于 .env 文件
"""
import os
import sys
from pathlib import Path

from langchain.text_splitter import MarkdownHeaderTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma

from app.core.config import get_settings

settings = get_settings()

# ============================================================
# 配置
# ============================================================

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CHROMA_DIR = Path(__file__).resolve().parent.parent / "chroma_db"

# 切片策略：按 Markdown 标题层级切分，保留章节上下文
HEADERS_TO_SPLIT = [
    ("#", "编"),       # 如 "第一编 总则"
    ("##", "章"),      # 如 "第一章 基本规定"
    ("###", "节"),     # 如 "第一节 一般规定"
    ("####", "条"),    # 如 "第五百八十五条"
]

# 要处理的法律文件（支持 glob 匹配）
LAW_FILES = [
    "民法典.md",
    "劳动法.md",
    "劳动合同法.md",
    "公司法.md",
]


def load_and_split(filepath: Path) -> list:
    """读取单个 Markdown 文件并按章节切片"""
    text = filepath.read_text(encoding="utf-8")
    splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=HEADERS_TO_SPLIT,
        strip_headers=False,   # 保留标题在 chunk 中
    )
    return splitter.split_text(text)


def init_chroma(docs: list):
    """将文档切片灌入 ChromaDB"""
    embeddings = OpenAIEmbeddings(
        model="text-embedding-3-small",
        openai_api_key=settings.deepseek_api_key,
        openai_api_base=settings.deepseek_base_url,
    )

    # 如果已有数据库，先清空（避免重复灌入）
    if CHROMA_DIR.exists():
        import shutil
        shutil.rmtree(CHROMA_DIR)

    vectorstore = Chroma.from_documents(
        documents=docs,
        embedding=embeddings,
        persist_directory=str(CHROMA_DIR),
        collection_name="laws",
    )

    print(f"✅ 向量库初始化完成")
    print(f"   文档分块数: {len(docs)}")
    print(f"   持久化路径: {CHROMA_DIR}")
    return vectorstore


def verify(vectorstore):
    """验证向量库可用性"""
    results = vectorstore.similarity_search("违约金过高怎么办", k=3)
    print(f"\n🔍 验证查询: '违约金过高怎么办'")
    for i, doc in enumerate(results, 1):
        preview = doc.page_content[:80].replace("\n", " ")
        print(f"   {i}. [{doc.metadata}] {preview}...")


def main():
    print("⚙️  开始初始化法律知识库...\n")

    # 收集所有法律文本
    filepaths = []
    for pattern in LAW_FILES:
        matches = list(DATA_DIR.glob(pattern))
        if matches:
            filepaths.extend(matches)
            print(f"   📄 找到: {matches[0].name}")
        else:
            print(f"   ⚠️  未找到: {pattern}（请先放入 data/ 目录）")

    if not filepaths:
        print("\n❌ 未找到任何法律文本文件，请先从 lawtext/laws 下载")
        print("   git clone https://github.com/lawtext/laws.git 并将 .md 文件放入 data/")
        sys.exit(1)

    # 切片
    print("\n🔄 文本切片中...")
    all_docs = []
    for fp in filepaths:
        docs = load_and_split(fp)
        all_docs.extend(docs)
        print(f"   {fp.name}: {len(docs)} 个分块")

    # 灌库
    print("\n💾 灌入 ChromaDB...")
    vectorstore = init_chroma(all_docs)

    # 验证
    verify(vectorstore)
    print("\n🎉 知识库就绪！")


if __name__ == "__main__":
    main()
