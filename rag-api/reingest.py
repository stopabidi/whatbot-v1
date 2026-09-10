import asyncio
import os
import threading
import time
import logging

logger = logging.getLogger(__name__)

_lock = asyncio.Lock() if hasattr(asyncio, 'Lock') else None
_sync_lock = threading.Lock()
_job_state = {
    'state': 'idle',
    'started_at': None,
    'finished_at': None,
    'chunks': 0,
    'error': None,
}


def get_status():
    return dict(_job_state)


def _run_ingest():
    try:
        _job_state['state'] = 'running'
        _job_state['started_at'] = time.time()
        _job_state['error'] = None
        from ingest import ingest_full
        ingest_full()
        try:
            from rag import reload as reload_rag
            reload_rag()
            logger.info("Query engine reloaded after rebuild")
        except Exception as e:
            logger.warning(f"Failed to reload query engine: {e}")
        try:
            import chromadb
            c = chromadb.PersistentClient(path=os.getenv('CHROMA_DIR', './chroma_db'))
            col = c.get_collection('professor_docs')
            _job_state['chunks'] = col.count()
        except Exception:
            _job_state['chunks'] = 0
        _job_state['state'] = 'done'
        _job_state['finished_at'] = time.time()
    except Exception as e:
        _job_state['state'] = 'error'
        _job_state['error'] = str(e)
        _job_state['finished_at'] = time.time()
        logger.error(f"Reingest failed: {e}")
    finally:
        _sync_lock.release()


def trigger_reingest():
    if not _sync_lock.acquire(blocking=False):
        return False
    try:
        t = threading.Thread(target=_run_ingest, daemon=True)
        t.start()
        return True
    finally:
        pass  # Lock released by _run_ingest thread
