"""
从 data/ 目录中的法律 Markdown 文件初始化 ChromaDB 向量数据库
用法：cd backend && python -m app.init_db
"""

import hashlib
import re
import shutil
import sys
from collections import OrderedDict
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlsplit

import chromadb
import httpx
from chromadb import EmbeddingFunction

from app.core.chroma_paths import chroma_persist_path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CHROMA_DIR = Path(__file__).resolve().parent.parent / "chroma_db"
OLLAMA_URL = "http://localhost:11434"
EMBED_MODEL = "qwen3-embedding"


def _ollama_trust_env(base_url: str) -> bool:
    """仅本机回环地址绕过环境代理，远程 Ollama 保留原有环境配置。"""
    hostname = (urlsplit(base_url).hostname or "").lower().rstrip(".")
    if hostname == "localhost":
        return False
    try:
        return not ip_address(hostname).is_loopback
    except ValueError:
        return True


def ollama_embed_batch(texts, model=EMBED_MODEL):
    """调用 Ollama 批量生成文本嵌入向量，带重试机制"""
    import time

    inputs = [t[:4000] for t in texts]
    with httpx.Client(timeout=300, trust_env=_ollama_trust_env(OLLAMA_URL)) as client:
        for _attempt in range(5):
            try:
                resp = client.post(
                    f"{OLLAMA_URL}/api/embed", json={"model": model, "input": inputs}
                )
                if resp.status_code == 500:
                    time.sleep(3)
                    continue
                resp.raise_for_status()
                return [
                    e.tolist() if hasattr(e, "tolist") else list(e)
                    for e in resp.json()["embeddings"]
                ]
            except Exception:
                time.sleep(3)
    raise RuntimeError("Embedding failed. Is Ollama running?")


def clean_markdown(text):
    """清洗 Markdown 格式标记，提取纯文本内容"""
    text = re.sub(r"\{\{%[^}]*%\}\}", "", text)
    text = re.sub(r"\{\{<[^>]*>\}\}", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"!\[.*?\]\(.*?\)", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def build_article_hierarchy(body):
    """解析法律文档的章节层级（H2/H3/H4），构建条文→层级路径映射"""
    lines = body.split(chr(10))
    current = {"h2": "", "h3": "", "h4": ""}
    article_map = OrderedDict()
    for line in lines:
        s = line.strip()
        if s.startswith("## "):
            h = re.sub(r"^##\s*", "", s)
            h = re.sub("[\u3000 ]+", "", h).strip()
            if h and "\u76ee" not in h:
                current["h2"] = h
                current["h3"] = ""
                current["h4"] = ""
        elif s.startswith("### "):
            h = re.sub(r"^###\s*", "", s)
            h = re.sub("[\u3000 ]+", "", h).strip()
            if h:
                current["h3"] = h
                current["h4"] = ""
        elif s.startswith("#### "):
            h = re.sub(r"^####\s*", "", s)
            h = re.sub("[\u3000 ]+", "", h).strip()
            if h:
                current["h4"] = h
        m = re.match(r"^-?\s*\*?\*?\u7b2c([\u4e00-\u9fa5\d]+)\u6761\*?\*?\s*(.*)", s)
        if m:
            path = " > ".join(p for p in [current["h2"], current["h3"], current["h4"]] if p)
            article_map[m.group(1)] = path
    return article_map


def split_by_article(body, law_name, hierarchy_map):
    """按条文切分法律正文，每条生成一个带层级信息的 chunk"""
    chunks = []
    pat = re.compile(
        r"(?:^|\n)-?\s*\*?\*?\u7b2c([\u4e00-\u9fa5\d]+)\u6761\*?\*?\s*(.*?)(?=\n(?:-?\s*\*?\*?\u7b2c[\u4e00-\u9fa5\d]+\u6761|#{2,5}\s)|\Z)",
        re.DOTALL,
    )
    matches = list(pat.finditer(body))
    if len(matches) <= 1:
        cpat = re.compile(
            r"(?:^|\n)(?:#{2,4}\s*)?\u7b2c[\u4e00-\u9fa5\d]+\u7ae0\s*.*?(?=\n(?:#{2,4}\s*)?\u7b2c[\u4e00-\u9fa5\d]+\u7ae0|\Z)",
            re.DOTALL,
        )
        cm = list(cpat.finditer(body))
        if len(cm) > 1:
            for m in cm:
                t = m.group().strip()
                if len(t) > 50:
                    chunks.append({"content": t, "article": "-", "law": law_name, "hierarchy": ""})
            return chunks
        paras = [p.strip() for p in body.split(chr(10) + chr(10)) if p.strip()]
        buf = ""
        for p in paras:
            if len(buf) + len(p) < 800:
                buf += (chr(10) if buf else "") + p
            else:
                if buf:
                    chunks.append(
                        {"content": buf, "article": "-", "law": law_name, "hierarchy": ""}
                    )
                buf = p
        if buf:
            chunks.append({"content": buf, "article": "-", "law": law_name, "hierarchy": ""})
        return chunks
    for m in matches:
        num = m.group(1)
        ab = m.group(2).strip()
        ft = "\u7b2c" + num + "\u6761 " + ab.strip()
        hier = hierarchy_map.get(num, "")
        hdr = "\u3010" + law_name + "\u3011"
        if hier:
            hdr += " " + hier
        # 去除条文内容末尾残留的章节标题
        ft_clean = re.sub(r"\n#{2,5}\s+第[一-龥\d]+[章节].*$", "", ft)
        chunk_content = hdr + chr(10) + chr(10) + ft_clean
        chunks.append(
            {
                "content": chunk_content,
                "article": "第" + num + "条",
                "law": law_name,
                "hierarchy": hier,
            }
        )
    return chunks


class OllamaEmbeddingFunction(EmbeddingFunction):
    """基于 Ollama API 的 ChromaDB 自定义嵌入函数"""

    def __init__(self, model="qwen3-embedding", base_url="http://localhost:11434"):
        self._model = model
        self._url = base_url

    def __call__(self, input):
        import time

        texts = [t[:4000] for t in input] if isinstance(input, list) else [input[:4000]]
        for _attempt in range(5):
            try:
                resp = httpx.post(
                    f"{self._url}/api/embed",
                    json={"model": self._model, "input": texts},
                    timeout=120,
                    trust_env=_ollama_trust_env(self._url),
                )
                if resp.status_code == 500:
                    time.sleep(3)
                    continue
                resp.raise_for_status()
                return [
                    e.tolist() if hasattr(e, "tolist") else list(e)
                    for e in resp.json()["embeddings"]
                ]
            except Exception as e:
                last_error = e
                time.sleep(3)
        raise RuntimeError(f"Embedding failed: {last_error}")

    def embed_query(self, input):
        if isinstance(input, list):
            return self(input)[0]
        return self([input])[0]


def main():
    print("Checking Ollama...")
    try:
        with httpx.Client(timeout=5, trust_env=_ollama_trust_env(OLLAMA_URL)) as c:
            c.get(OLLAMA_URL + "/api/tags").raise_for_status()
        print("  Ollama running, model: " + EMBED_MODEL)
    except Exception:
        print("  ERROR: Ollama not responding")
        sys.exit(1)
    md_files = sorted(DATA_DIR.glob("*.md"))
    if not md_files:
        print("ERROR: No .md files")
        sys.exit(1)
    print("\nFound " + str(len(md_files)) + " laws:")
    for fp in md_files:
        print("  " + fp.name)
    all_chunks = []
    for fp in md_files:
        print("\nProcessing: " + fp.name)
        with open(fp, encoding="utf-8") as f:
            raw = f.read()
        if len(raw) < 200:
            print("  Skip")
            continue
        law_name = fp.stem
        body = raw
        if raw.startswith("---"):
            idx = raw.find("---", 4)
            if idx > 0:
                for line in raw[4:idx].strip().split(chr(10)):
                    if line.strip().startswith("title:"):
                        law_name = line.strip()[6:].strip().strip(chr(39) + chr(34))
                body = raw[idx + 3 :].strip()
        body = clean_markdown(body)
        hm = build_article_hierarchy(body)
        print("  Hierarchy: " + str(len(hm)) + " articles")
        chunks = split_by_article(body, law_name, hm)
        print("  Chunks: " + str(len(chunks)))
        all_chunks.extend(chunks)
    print("\nTotal chunks: " + str(len(all_chunks)))
    print("\nBuilding ChromaDB...")
    database_exists = CHROMA_DIR.exists()
    client = chromadb.PersistentClient(path=chroma_persist_path(CHROMA_DIR))
    if database_exists:
        print("ChromaDB already exists. Use --force to rebuild.")
        print(f"Path: {CHROMA_DIR}")
        collection = client.get_collection(
            "laws", embedding_function=OllamaEmbeddingFunction(model=EMBED_MODEL)
        )
        print(f"Existing vectors: {collection.count()}")
        verify_query(collection)
        return
    ef = OllamaEmbeddingFunction(model=EMBED_MODEL)
    collection = client.create_collection(
        name="laws", metadata={"hnsw:space": "cosine"}, embedding_function=ef
    )
    bs = 32
    ci = 0
    for i in range(0, len(all_chunks), bs):
        batch = all_chunks[i : i + bs]
        texts = [c["content"] for c in batch]
        ids = [
            hashlib.md5(("law_" + str(ci + j) + ":" + t[:30]).encode()).hexdigest()[:24]
            for j, t in enumerate(texts)
        ]
        metas = [
            {"law": c["law"], "article": c["article"], "hierarchy": c["hierarchy"]} for c in batch
        ]
        print(
            "  Embedding " + str(i // bs + 1) + "/" + str((len(all_chunks) - 1) // bs + 1) + " ..."
        )
        try:
            embs = ollama_embed_batch(texts)
        except RuntimeError as e:
            print("  ERROR: " + str(e))
            sys.exit(1)
        valid = [
            (t, e, mid, m)
            for t, e, mid, m in zip(texts, embs, ids, metas, strict=True)
            if e is not None
        ]
        if valid:
            vt, ve, vi, vm = zip(*valid, strict=True)
            collection.add(
                ids=list(vi), documents=list(vt), embeddings=list(ve), metadatas=list(vm)
            )
            import time

            time.sleep(0.5)
        ci += len(batch)
    print("\nDone! Vectors: " + str(collection.count()))
    verify_query(collection)
    print("\nDone!")


def verify_query(collection):
    """验证向量库是否正常：用测试查询检索并打印前3条结果"""
    print("\nVerify:")
    ef = OllamaEmbeddingFunction(model=EMBED_MODEL)
    q_emb = ef(["违约金过高怎么办"])[0]
    results = collection.query(query_embeddings=[q_emb], n_results=3)
    for i in range(len(results["documents"][0])):
        d = results["documents"][0][i][:150].replace(chr(10), " ")
        m = results["metadatas"][0][i]
        print(
            "  " + str(i + 1) + ". [" + m["law"] + "] " + m.get("article", "") + " | " + d + "..."
        )


if __name__ == "__main__":
    import sys

    if "--force" in sys.argv or "--rebuild" in sys.argv:
        if CHROMA_DIR.exists():
            shutil.rmtree(CHROMA_DIR)
            print("Rebuilding from scratch...")
        else:
            print("No existing DB to rebuild.")
    main()
