"""
Law knowledge base retriever - ChromaDB + Ollama
"""
import chromadb
import os as _os
from pathlib import Path
from app.init_db import OllamaEmbeddingFunction

_db = Path(__file__).resolve().parent.parent.parent / "chroma_db"
_rel = _os.path.relpath(str(_db), _os.getcwd())

_client = None
_collection = None
_ef = None


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


class LawRetriever:

    def _embed(self, text: str):
        emb = _ef([text])[0]
        return [float(x) for x in emb]

    def search(self, query: str, top_k: int = 5):
        q_emb = self._embed(query)
        results = _collection.query(query_embeddings=[q_emb], n_results=top_k)
        docs = []
        for i in range(len(results["documents"][0])):
            meta = results["metadatas"][0][i]
            docs.append({
                "content": results["documents"][0][i],
                "law": meta.get("law", ""),
                "article": meta.get("article", ""),
                "hierarchy": meta.get("hierarchy", ""),
            })
        return docs

    def search_as_context(self, query: str, top_k: int = 5) -> str:
        results = self.search(query, top_k)
        if not results:
            return "No relevant laws found."
        parts = []
        for i, r in enumerate(results, 1):
            src = r["law"]
            if r["hierarchy"]:
                src += " > " + r["hierarchy"]
            if r["article"] and r["article"] != "-":
                src += " " + r["article"]
            line = "[" + str(i) + "] [" + src + "]" + chr(10) + r["content"]
            parts.append(line)
        return (chr(10)+chr(10)).join(parts)


_retriever = None


def get_retriever():
    global _retriever
    _init()
    if _retriever is None:
        _retriever = LawRetriever()
    return _retriever


# Eager init to avoid ChromaDB SharedSystemClient bug in async context
_init()
