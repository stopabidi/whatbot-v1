import hashlib
import json
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Security, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

from config import DOCUMENTS_DIR, STORAGE_DIR, RAG_API_KEY
from rag import query_rag, reload as reload_rag, get_chroma_write_lock
from rag import get_chroma_client
from reingest import trigger_reingest, get_status as get_reingest_status

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)


def verify_api_key(cred: HTTPAuthorizationCredentials = Security(security)):
    if not cred or cred.credentials != RAG_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def validate_file_path(file_path: str) -> str:
    resolved = os.path.realpath(file_path)
    docs_resolved = os.path.realpath(DOCUMENTS_DIR)
    if not resolved.startswith(docs_resolved + os.sep) and resolved != docs_resolved:
        raise HTTPException(status_code=403, detail="Path outside documents directory")
    if not os.path.isfile(resolved):
        raise HTTPException(status_code=404, detail="File not found")
    return resolved


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("RAG API starting up...")
    yield
    logger.info("RAG API shutting down.")

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Simple in-memory rate limiter
import collections
rate_limit_store = collections.defaultdict(list)
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX = 30  # requests per window

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    
    # Clean old requests
    rate_limit_store[client_ip] = [t for t in rate_limit_store[client_ip] if now - t < RATE_LIMIT_WINDOW]
    
    if len(rate_limit_store[client_ip]) >= RATE_LIMIT_MAX:
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded. Try again later."}
        )
    
    rate_limit_store[client_ip].append(now)
    return await call_next(request)


class QueryRequest(BaseModel):
    question: str
    conversation_history: list = []

    @field_validator('question')
    @classmethod
    def question_must_not_be_empty(cls, v):
        if not v or not v.strip():
            raise ValueError('Question must not be empty')
        if len(v) > 10000:
            raise ValueError('Question too long (max 10000 chars)')
        return v.strip()

    @field_validator('conversation_history')
    @classmethod
    def limit_history(cls, v):
        if len(v) > 20:
            return v[-20:]
        return v


class IngestRequest(BaseModel):
    file_path: str


@app.post("/query", dependencies=[Depends(verify_api_key)])
async def query_endpoint(req: QueryRequest):
    rs = get_reingest_status()
    if rs['state'] == 'running':
        return {
            "answer": "I'm updating my knowledge base. Try again in a minute.",
            "sources": [],
            "offer_file": None,
        }
    result = await query_rag(req.question, history=req.conversation_history)
    return result


@app.post("/ingest", dependencies=[Depends(verify_api_key)])
async def ingest_endpoint(req: IngestRequest):
    def _do_ingest():
        import chromadb
        from llama_index.core import (
            SimpleDirectoryReader, StorageContext, load_index_from_storage,
        )
        from llama_index.vector_stores.chroma import ChromaVectorStore

        safe_path = validate_file_path(req.file_path)

        manifest_path = os.path.join(STORAGE_DIR, "processed_files.json")
        try:
            manifest = json.load(open(manifest_path))
        except FileNotFoundError:
            manifest = {}

        file_hash = hashlib.sha256(open(safe_path, "rb").read()).hexdigest()
        filename = os.path.basename(safe_path)

        reverse_manifest = {v: k for k, v in manifest.items()}
        if safe_path in reverse_manifest and reverse_manifest[safe_path] != file_hash:
            old_hash = None
            for h, p in manifest.items():
                if p == safe_path:
                    old_hash = h
                    break
            if old_hash:
                del manifest[old_hash]

        if file_hash in manifest:
            return {"status": "already_exists", "filename": filename, "chunks": 0}

        chroma_client = get_chroma_client()
        try:
            chroma_collection = chroma_client.get_collection("professor_docs")
        except Exception:
            chroma_collection = chroma_client.create_collection("professor_docs")

        vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
        storage_context = StorageContext.from_defaults(
            persist_dir=STORAGE_DIR, vector_store=vector_store,
        )
        idx = load_index_from_storage(storage_context)

        docs = SimpleDirectoryReader(input_files=[safe_path]).load_data()
        for doc in docs:
            idx.insert(doc)

        storage_context.persist(persist_dir=STORAGE_DIR)

        manifest[file_hash] = safe_path
        os.makedirs(STORAGE_DIR, exist_ok=True)
        json.dump(manifest, open(manifest_path, "w"), indent=2)

        return {"status": "ok", "filename": filename, "chunks": len(docs)}

    import asyncio
    result = await asyncio.to_thread(_do_ingest)
    if result.get("status") == "ok":
        with get_chroma_write_lock():
            reload_rag()
    return result


@app.post("/reload", dependencies=[Depends(verify_api_key)])
async def reload_endpoint():
    global _document_cache, _document_cache_time
    _document_cache = None
    _document_cache_time = 0
    reload_rag()
    return {"status": "ok"}


@app.post("/reingest", dependencies=[Depends(verify_api_key)])
async def reingest_endpoint():
    status = get_reingest_status()
    if status['state'] == 'running':
        raise HTTPException(status_code=409, detail="Reingest already running")
    trigger_reingest()
    return {"status": "started"}


@app.get("/reingest/status", dependencies=[Depends(verify_api_key)])
async def reingest_status_endpoint():
    return get_reingest_status()


_document_cache = None
_document_cache_time = 0
DOCUMENT_CACHE_TTL = 60

@app.get("/documents", dependencies=[Depends(verify_api_key)])
async def list_documents():
    global _document_cache, _document_cache_time

    if _document_cache is not None and time.time() - _document_cache_time < DOCUMENT_CACHE_TTL:
        return {"documents": _document_cache}

    files = []
    for root, dirs, filenames in os.walk(DOCUMENTS_DIR):
        for f in filenames:
            if f.lower().endswith(('.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.png', '.jpg', '.jpeg')):
                rel_path = os.path.relpath(os.path.join(root, f), DOCUMENTS_DIR)
                files.append(rel_path)

    _document_cache = sorted(files)
    _document_cache_time = time.time()

    return {"documents": _document_cache}


@app.get("/health")
async def health():
    return {"status": "ok"}
