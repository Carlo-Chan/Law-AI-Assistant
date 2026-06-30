"""
Law knowledge base retriever - ChromaDB + Ollama, no LangChain wrapper
"""
import httpx, chromadb
from pathlib import Path

CHROMA_DIR = Path(__file__).resolve().parent.parent.parent / "chroma_db"
OLLAMA_URL = "http://localhost:11434"
EMBED_MODEL = "qwen3-embedding"


class LawRetriever:

    def __init__(self):
        self._client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        self._collection = self._client.get_collection("laws")

    def _embed(self, text: str):
        import time
        for attempt in range(5):
            try:
                resp = httpx.post(
                    f"{OLLAMA_URL}/api/embed",
                    json={"model": EMBED_MODEL, "input": [text]},
                    timeout=120,
                )
                if resp.status_code == 500:
                    time.sleep(3); continue
                resp.raise_for_status()
                return resp.json()["embeddings"][0]
            except Exception:
                time.sleep(3)
        raise RuntimeError("Embedding failed")

    def search(self, query: str, top_k: int = 5):
        q_emb = self._embed(query)
        results = self._collection.query(query_embeddings=[q_emb], n_results=top_k)
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
    if _retriever is None:
        _retriever = LawRetriever()
    return _retriever