"""Usage: python ingest.py --mode full|add"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

import chromadb
from llama_index.core import (
    Settings, SimpleDirectoryReader, StorageContext,
    VectorStoreIndex, load_index_from_storage, Document,
)
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.vector_stores.chroma import ChromaVectorStore

from config import EMBED_MODEL_NAME, EMBED_DEVICE, DOCUMENTS_DIR, STORAGE_DIR, CHROMA_DIR

Settings.embed_model = HuggingFaceEmbedding(model_name=EMBED_MODEL_NAME, device=EMBED_DEVICE)

COLLECTION = "professor_docs"
MANIFEST = os.path.join(STORAGE_DIR, "processed_files.json")


def enrich_chunk(chunk_text, file_name, file_path):
    """Prefix chunk with document context for better embedding."""
    if not file_name:
        return chunk_text
    
    title = file_name
    for ext in ['.pdf', '.md', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.txt']:
        title = title.replace(ext, '')
    for prefix in ['Reading - ', 'Tool - ', 'eBook - ', 'Advice - ', 'Guidance - ', 'Workshop - ']:
        if title.startswith(prefix):
            title = title[len(prefix):]
    
    if not title.strip():
        return chunk_text
    
    return f"[{title.strip()}] {chunk_text}"


def file_hash(fp):
    h = hashlib.md5()
    with open(fp, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest():
    try:
        return json.load(open(MANIFEST))
    except FileNotFoundError:
        return {}


def save_manifest(m):
    os.makedirs(STORAGE_DIR, exist_ok=True)
    json.dump(m, open(MANIFEST, "w"), indent=2)


SUPPORTED_EXTENSIONS = (".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".png", ".jpg", ".jpeg", ".md")


def discover():
    return sorted(str(p) for p in Path(DOCUMENTS_DIR).rglob("*")
                  if p.suffix.lower() in SUPPORTED_EXTENSIONS)


def _relative_path(fp):
    try:
        return str(Path(fp).relative_to(DOCUMENTS_DIR))
    except ValueError:
        return os.path.basename(fp)


def extract_xlsx(filepath):
    try:
        import openpyxl
        wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
        text_parts = []
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            if not hasattr(ws, 'iter_rows'):
                text_parts.append(f"[Sheet: {sheet_name} - Chart sheet, skipped]")
                continue
            text_parts.append(f"[Sheet: {sheet_name}]")
            for row in ws.iter_rows(values_only=True):
                row_text = " | ".join(str(cell) for cell in row if cell is not None)
                if row_text.strip():
                    text_parts.append(row_text)
        wb.close()
        return "\n".join(text_parts)
    except Exception as e:
        return f"[Error reading XLSX: {e}]"


def extract_pptx(filepath):
    try:
        from pptx import Presentation
        prs = Presentation(filepath)
        text_parts = []
        for i, slide in enumerate(prs.slides, 1):
            text_parts.append(f"[Slide {i}]")
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        text = para.text.strip()
                        if text:
                            text_parts.append(text)
            if slide.has_notes_slide:
                try:
                    notes = slide.notes_slide.notes_text_frame.text.strip()
                    if notes:
                        text_parts.append(f"[Notes: {notes}]")
                except AttributeError:
                    pass
        return "\n".join(text_parts)
    except Exception as e:
        return f"[Error reading PPTX: {e}]"


def extract_text_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except Exception as e:
        return f"[Error reading text file: {e}]"


def get_custom_reader(filepath):
    ext = Path(filepath).suffix.lower()
    if ext in ('.xlsx', '.xls'):
        return extract_xlsx
    elif ext in ('.pptx', '.ppt'):
        return extract_pptx
    elif ext == '.txt':
        return extract_text_file
    return None


def get_file_hash(filepath):
    hasher = hashlib.md5()
    with open(filepath, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def verify_labels(docs):
    missing = sum(1 for d in docs if not d.metadata.get("page_label"))
    if missing:
        print(f"  WARNING: {missing} chunks have no page_label")


def ingest_full():
    print("Mode: FULL REBUILD")
    client = chromadb.PersistentClient(path=CHROMA_DIR)
    try:
        client.delete_collection(COLLECTION)
        print("  Deleted existing collection.")
    except ValueError:
        pass

    collection = client.create_collection(COLLECTION)
    vs = ChromaVectorStore(chroma_collection=collection)
    sc = StorageContext.from_defaults(vector_store=vs)

    files = discover()
    if not files:
        print("  No documents found.")
        return

    standard_files = []
    custom_files = []

    for fp in files:
        ext = Path(fp).suffix.lower()
        if ext in ('.pdf', '.docx', '.doc', '.md'):
            standard_files.append(fp)
        elif ext in ('.xlsx', '.xls', '.pptx', '.ppt', '.txt'):
            custom_files.append(fp)
        elif ext in ('.png', '.jpg', '.jpeg'):
            print(f"  SKIP (image): {os.path.basename(fp)}")
        else:
            print(f"  SKIP (unsupported): {os.path.basename(fp)}")

    print(f"  Processing {len(standard_files)} standard files (PDF/DOCX)...")
    indexed_count = 0

    if standard_files:
        try:
            first_docs = SimpleDirectoryReader(input_files=[standard_files[0]]).load_data()
            verify_labels(first_docs)
            # Enrich first file's documents (fix: first file was bypassing enrichment)
            enriched_first_docs = []
            for d in first_docs:
                enriched_text = enrich_chunk(d.text, os.path.basename(standard_files[0]), standard_files[0])
                enriched_doc = Document(text=enriched_text, metadata=d.metadata)
                enriched_first_docs.append(enriched_doc)
            idx = VectorStoreIndex.from_documents(enriched_first_docs, storage_context=sc)
            indexed_count += len(first_docs)
            print(f"  Indexed first file: {os.path.basename(standard_files[0])} ({len(first_docs)} chunks)")

            for fp in standard_files[1:]:
                try:
                    docs = SimpleDirectoryReader(input_files=[fp]).load_data()
                    verify_labels(docs)
                    for d in docs:
                        enriched_text = enrich_chunk(d.text, os.path.basename(fp), fp)
                        enriched_doc = Document(text=enriched_text, metadata=d.metadata)
                        idx.insert(enriched_doc)
                    indexed_count += len(docs)
                except Exception as e:
                    print(f"  SKIP (error): {os.path.basename(fp)} — {e}")
        except Exception as e:
            print(f"  ERROR processing first file: {e}")

    print(f"  Indexed {indexed_count} chunks from standard files.")

    sc.persist(persist_dir=STORAGE_DIR)

    idx = load_index_from_storage(sc)

    print(f"  Processing {len(custom_files)} custom files (XLSX/PPTX/TXT)...")
    custom_count = 0
    for fp in custom_files:
        try:
            reader_func = get_custom_reader(fp)
            if reader_func:
                text = reader_func(fp)
                if text and not text.startswith('[Error'):
                    enriched_text = enrich_chunk(text, os.path.basename(fp), fp)
                    doc = Document(
                        text=enriched_text,
                        metadata={
                            "file_name": os.path.basename(fp),
                            "file_path": _relative_path(fp),
                        }
                    )
                    idx.insert(doc)
                    custom_count += 1
                    print(f"  Added: {os.path.basename(fp)} ({len(text)} chars)")
                else:
                    print(f"  WARNING: {os.path.basename(fp)} — {text}")
        except Exception as e:
            print(f"  ERROR: {os.path.basename(fp)}: {e}")

    sc.persist(persist_dir=STORAGE_DIR)
    save_manifest({file_hash(f): _relative_path(f) for f in files})
    print(f"  Done. Total: {indexed_count + custom_count} chunks from {len(standard_files) + len(custom_files)} files.")


def ingest_add():
    print("Mode: INCREMENTAL")
    client = chromadb.PersistentClient(path=CHROMA_DIR)
    try:
        collection = client.get_collection(COLLECTION)
    except ValueError:
        print("  No collection. Run --mode full first.")
        return

    vs = ChromaVectorStore(chroma_collection=collection)
    sc = StorageContext.from_defaults(persist_dir=STORAGE_DIR, vector_store=vs)
    idx = load_index_from_storage(sc)

    manifest = load_manifest()

    all_files = discover()
    current_hashes = {file_hash(f): f for f in all_files}

    reverse_manifest = {v: k for k, v in manifest.items()}
    for fp in all_files:
        if fp in reverse_manifest and reverse_manifest[fp] != file_hash(fp):
            print(f"  WARNING: {os.path.basename(fp)} was modified but old chunks remain. Run --mode full.")

    new_files = [f for h, f in current_hashes.items() if h not in manifest]
    if not new_files:
        print("  No new files.")
        return

    for fp in new_files:
        try:
            ext = Path(fp).suffix.lower()

            if ext in ('.png', '.jpg', '.jpeg'):
                print(f"  SKIP (image): {os.path.basename(fp)}")
                continue

            if ext in ('.xlsx', '.xls', '.pptx', '.ppt', '.txt'):
                reader_func = get_custom_reader(fp)
                if reader_func:
                    text = reader_func(fp)
                    if text and not text.startswith('[Error'):
                        enriched_text = enrich_chunk(text, os.path.basename(fp), fp)
                        doc = Document(
                            text=enriched_text,
                            metadata={
                                "file_name": os.path.basename(fp),
                                "file_path": _relative_path(fp),
                            }
                        )
                        idx.insert(doc)
                        manifest[file_hash(fp)] = _relative_path(fp)
                        print(f"  Added: {os.path.basename(fp)} ({len(text)} chars)")
                    else:
                        print(f"  WARNING: {os.path.basename(fp)} — {text}")
            else:
                docs = SimpleDirectoryReader(input_files=[fp]).load_data()
                verify_labels(docs)
                for d in docs:
                    enriched_text = enrich_chunk(d.text, os.path.basename(fp), fp)
                    enriched_doc = Document(text=enriched_text, metadata=d.metadata)
                    idx.insert(enriched_doc)
                manifest[file_hash(fp)] = _relative_path(fp)
                print(f"  Added: {os.path.basename(fp)} ({len(docs)} chunks)")
        except Exception as e:
            print(f"  ERROR: {fp}: {e}")

    sc.persist(persist_dir=STORAGE_DIR)
    save_manifest(manifest)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["full", "add"], required=True)
    args = parser.parse_args()
    {"full": ingest_full, "add": ingest_add}[args.mode]()
