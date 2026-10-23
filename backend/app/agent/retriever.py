"""
法律知识库检索器 —— ChromaDB 向量检索 + BM25 关键词检索
"""

import os as _os
from pathlib import Path

import chromadb
import jieba
from rank_bm25 import BM25Okapi

from app.init_db import OllamaEmbeddingFunction

_db = Path(__file__).resolve().parent.parent.parent / "chroma_db"
_rel = str(_db)

_client = None
_collection = None
_ef = None
_bm25 = None
_bm25_docs = None


def _bm25_tokenize(text):
    """中文分词，用于 BM25 关键词检索"""
    return list(jieba.cut(text))


# 初始化 ChromaDB 客户端和集合（懒加载）
def _init():
    global _client, _collection, _ef
    if _client is not None:
        return
    _ef = OllamaEmbeddingFunction()
    _client = chromadb.PersistentClient(path=_rel)
    _collection = _client.get_or_create_collection(
        name="laws",
        embedding_function=_ef,
    )
    global _bm25, _bm25_docs
    if _bm25 is None:
        _build_bm25()


def _build_bm25():
    """从 ChromaDB 全量文档构建 BM25 关键词索引"""
    global _bm25, _bm25_docs
    try:
        all_data = _collection.get(include=["documents", "metadatas"])
        _bm25_docs = []
        tokenized_corpus = []
        for i, doc in enumerate(all_data["documents"]):
            tokens = _bm25_tokenize(doc)
            tokenized_corpus.append(tokens)
            _bm25_docs.append(
                {
                    "content": doc,
                    "law": all_data["metadatas"][i].get("law", ""),
                    "article": all_data["metadatas"][i].get("article", ""),
                    "hierarchy": all_data["metadatas"][i].get("hierarchy", ""),
                }
            )
        _bm25 = BM25Okapi(tokenized_corpus)
    except Exception:
        _bm25 = None
        _bm25_docs = []


class LawRetriever:
    """法律知识库检索器：向量语义检索 + BM25 关键词检索 + 精确法条匹配"""

    def _embed(self, text: str):
        """调用 Ollama 生成单条文本的嵌入向量"""
        try:
            emb = _ef([text])[0]
            return [float(x) for x in emb]
        except Exception as ex:
            raise RuntimeError(f"Ollama embedding failed (is Ollama running?): {ex}") from ex

    def search(self, query: str, top_k: int = 5):
        """向量语义检索：返回 top_k 条最相似的法律条文"""
        try:
            q_emb = self._embed(query)
            results = _collection.query(query_embeddings=[q_emb], n_results=top_k)
        except Exception:
            return []
        docs = []
        for i in range(len(results["documents"][0])):
            meta = results["metadatas"][0][i]
            docs.append(
                {
                    "content": results["documents"][0][i],
                    "law": meta.get("law", ""),
                    "article": meta.get("article", ""),
                    "hierarchy": meta.get("hierarchy", ""),
                }
            )
        return docs

    def search_by_articles(self, article_nums, law_aliases=None):
        """精确法条号检索：按条文号精确匹配，支持法律名过滤"""
        docs = []
        for law_kw, num in article_nums:
            try:
                results = _collection.get(where={"article": num})
                if results.get("documents"):
                    for i in range(len(results["documents"])):
                        meta = results["metadatas"][i] if results.get("metadatas") else {}
                        doc_law = meta.get("law", "")
                        if law_kw and law_aliases:
                            target_law = law_aliases.get(law_kw, "")
                            if target_law and doc_law != target_law:
                                continue
                        docs.append(
                            {
                                "content": results["documents"][i],
                                "law": doc_law,
                                "article": meta.get("article", ""),
                                "hierarchy": meta.get("hierarchy", ""),
                            }
                        )
            except Exception:
                continue
        return docs

    def search_bm25(self, query: str, top_k: int = 5):
        """BM25 关键词检索：基于词频和逆文档频率打分"""
        global _bm25, _bm25_docs
        if _bm25 is None or not _bm25_docs:
            return []
        try:
            tokens = _bm25_tokenize(query)
            scores = _bm25.get_scores(tokens)
            # 获取 top_k 个结果的索引
            top_indices = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
            docs = []
            for idx in top_indices:
                if scores[idx] > 0:
                    docs.append(dict(_bm25_docs[idx]))
            return docs
        except Exception:
            return []

    def format_results(self, results):
        """将结果列表格式化为 LLM 上下文文本"""
        if not results:
            return "未检索到相关法条。"
        parts = []
        for i, r in enumerate(results, 1):
            src = r["law"]
            if r.get("hierarchy"):
                src += " 〉 " + r["hierarchy"]
            if r.get("article") and r["article"] != "-":
                src += " " + r["article"]
            line = "[" + str(i) + "] [" + src + "]" + chr(10) + r["content"]
            parts.append(line)
        return (chr(10) + chr(10)).join(parts)

    def search_as_context(self, query: str, top_k: int = 5) -> str:
        """便捷方法：检索并直接返回格式化后的上下文字符串"""
        results = self.search(query, top_k)
        return self.format_results(results)


_retriever = None


# 获取检索器单例
def get_retriever():
    global _retriever
    _init()
    if _retriever is None:
        _retriever = LawRetriever()
    return _retriever


# 预初始化，避免 ChromaDB 在异步上下文中出现 SharedSystemClient 错误
# 测试环境可通过 LAW_AI_SKIP_RETRIEVER_INIT=1 跳过（此时检索器按需惰性初始化）
if _os.environ.get("LAW_AI_SKIP_RETRIEVER_INIT") != "1":
    _init()
