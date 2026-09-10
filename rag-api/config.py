import os
import sys
from dotenv import load_dotenv

load_dotenv()

# llama-server — OpenAI-compatible API
LLAMA_SWAP_URL = os.getenv("LLAMA_SWAP_URL", "http://localhost:8080")
LLAMA_MODEL = os.getenv("LLAMA_MODEL", "/path/to/your/model")
LLAMA_TEMPERATURE = float(os.getenv("LLAMA_TEMPERATURE", "0.1"))
LLAMA_API_KEY = os.getenv("LLAMA_API_KEY", "sk-placeholder")

EMBED_MODEL_NAME = os.getenv("EMBED_MODEL_NAME", "BAAI/bge-m3")
EMBED_DEVICE = os.getenv("EMBED_DEVICE", "cuda")

DOCUMENTS_DIR = os.getenv("DOCUMENTS_DIR", "./documents")
STORAGE_DIR = os.getenv("STORAGE_DIR", "./storage")
CHROMA_DIR = os.getenv("CHROMA_DIR", "./chroma_db")
SIMILARITY_TOP_K = int(os.getenv("SIMILARITY_TOP_K", "5"))
FILE_OFFER_THRESHOLD = float(os.getenv("FILE_OFFER_THRESHOLD", "0.35"))

RAG_API_KEY = os.getenv("RAG_API_KEY", "")

if not RAG_API_KEY:
    print("FATAL: RAG_API_KEY is not set. Generate one with: openssl rand -hex 32", file=sys.stderr)
    sys.exit(1)
