"""
WhatBot v1 OV3 — Tool-Calling Architecture

The LLM is the brain. RAG is a tool.
- search_documents: LLM calls this when it needs information from Joe's docs
- send_document: LLM calls this when user wants a specific file
- Query expansion runs as a backend step when search is called
- No CRITICAL RULES — Joe's writing style in system prompt
"""

import asyncio
import json
import os
import re
import threading
import time

import chromadb
import requests
from llama_index.core import Settings, StorageContext, load_index_from_storage
from llama_index.core.schema import QueryBundle
from llama_index.llms.openai_like import OpenAILike
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.core.retrievers import VectorIndexRetriever
from llama_index.core.postprocessor import SentenceTransformerRerank

from config import (
    LLAMA_SWAP_URL, LLAMA_MODEL, LLAMA_TEMPERATURE, LLAMA_API_KEY,
    EMBED_MODEL_NAME, EMBED_DEVICE, CHROMA_DIR, STORAGE_DIR,
    FILE_OFFER_THRESHOLD, DOCUMENTS_DIR,
)

# =============================================================================
# LLM + Embedding Setup
# =============================================================================

Settings.llm = OpenAILike(
    model=LLAMA_MODEL,
    api_base=f"{LLAMA_SWAP_URL}/v1",
    api_key=LLAMA_API_KEY,
    temperature=LLAMA_TEMPERATURE,
    max_tokens=2048,
    request_timeout=360.0,
    context_window=65536,
    is_chat_model=True,
)
Settings.embed_model = HuggingFaceEmbedding(model_name=EMBED_MODEL_NAME, device=EMBED_DEVICE)

try:
    Settings.llm.complete("Hello", max_tokens=5)
    print("[RAG] LLM model pre-warmed")
except Exception as e:
    print(f"[RAG] LLM pre-warm failed (non-fatal): {e}")

_index_lock = threading.Lock()
_chroma_write_lock = threading.Lock()
_retriever = None

_reranker = SentenceTransformerRerank(
    model="BAAI/bge-reranker-v2-m3",
    top_n=10,
)

_chroma_client = None


def get_chroma_client():
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)
    return _chroma_client


# =============================================================================
# TOOL DEFINITIONS
# =============================================================================

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": "Search [CLIENT]'s consulting research documents. Use this when you need specific information from [CLIENT]'s published work about consulting, strategy, management, pricing, growth, exits, or professional services.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for in Joe's documents"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "send_document",
            "description": "Send a document file to the user via WhatsApp. Call this IMMEDIATELY when the user asks to receive, download, or be sent a file, paper, or document. Do NOT search first — do NOT use search_documents — just send the file directly.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The name of the document to send"
                    }
                },
                "required": ["filename"]
            }
        }
    }
]


# =============================================================================
# SYSTEM PROMPT (Joe's Writing Style)
# =============================================================================

SYSTEM_PROMPT = """You are WhatBot v1, a senior consultant who specialises in professional services.

TOOLS:
- search_documents: Use ONCE when you need specific facts. Never search multiple times.
- send_document: Use IMMEDIATELY when the user asks to receive, download, or be sent a file. Do not search first.

ANSWERING:
If search results are even partially relevant, answer with what you have. Synthesize from available information. Only refuse if you found nothing on the topic at all.

HOW TO SPEAK:
You are the expert. You already know this. Everything you say is your own knowledge. You searched for it, now you know it — just say it directly.
Never reference sources, documents, search results, or authors. Never say "based on", "according to", "the research shows", "the document says", "the search results suggest", "I found", "as mentioned in". Never name a professor, paper, or book. Just state the answer.

"The 7 layers are..." not "According to the research, the 7 layers are..."
"Most consultancies undercharge because..." not "The document suggests consultancies undercharge because..."

Plain English. Short sentences. Bullets where suitable (use • for bullets, numbered lists for steps). Use Markdown headings (## Section Name) to separate sections. British English (organise, analyse, programme). No code blocks, no em-dashes.
For greetings (hello, hi, good morning, how are you), keep it brief: "Hello. How can I help?" — do not mention consulting, professional services, or your specialisation unless the user asks about it.
Banned words: delve, tapestry, unpack, anchored, key-person, game-changing, at the end of the day, here is the thing, let us unpack.
Banned patterns: metaphors, aphorisms, cute lines, personification, throat-clearing transitions, staccato two-beat pairs.
Use subordinate clauses ("Although X, the firm saw Y" not "X. The firm saw Y").
Balance before criticism. Caveats inline in brackets. Soften superlatives ("a damaging way" not "the most damaging way").
If you do not know, say "I don't have that on hand" — nothing more."""


# =============================================================================
# RETRIEVAL SYSTEM (kept from v7 — this is the tool backend)
# =============================================================================

# --- Word Boundary Matching ---

def matches_keyword(keyword, query_lower):
    """Word-boundary matching: 'rate' matches 'day rate' but NOT 'strategies'."""
    escaped = re.escape(keyword)
    pattern = r'\b' + escaped + r'\b'
    return bool(re.search(pattern, query_lower))


# --- Category Detection ---

FOLDER_TO_CATEGORY = {
    "01 Vision & Strategy": "strategy",
    "02 Clients & Relationships": "clients",
    "03 Services & Pricing": "pricing",
    "04 Sales & Pipeline": "sales",
    "05 Cost Optimisation": "costs",
    "06 Market Profile & Marketing": "marketing",
    "07 People": "people",
    "08 Delivery": "delivery",
    "09 Leadership & Governance": "governance",
    "10 Exit Planning": "exit",
}

def infer_category(file_path):
    """Infer document category from folder path."""
    parts = file_path.split("/app/documents/")
    if len(parts) > 1:
        folder = parts[1].split("/")[0]
        return FOLDER_TO_CATEGORY.get(folder, "unknown")
    return "unknown"


QUERY_CATEGORY_HINTS = {
    "price": "pricing", "pricing": "pricing", "fee": "pricing", "fees": "pricing",
    "rate": "pricing", "rates": "pricing", "charge": "pricing", "charging": "pricing",
    "day rate": "pricing", "blended": "pricing", "retainer": "pricing", "billable": "pricing",
    "growth": "strategy", "inflection": "strategy", "plateau": "strategy",
    "scaling": "strategy", "scale": "strategy", "layers": "strategy",
    "framework": "strategy", "performance": "strategy", "specialising": "strategy",
    "specializing": "strategy", "specialisation": "strategy", "specialization": "strategy",
    "focus": "strategy", "niche": "strategy", "distortion": "strategy",
    "trap": "strategy", "stagnation": "strategy", "bottleneck": "strategy",
    "differentiating": "strategy", "differentiation": "strategy", "differentiate": "strategy",
    "competitive": "strategy", "strategic": "strategy",
    "people": "people", "talent": "people", "team": "people", "staff": "people",
    "competence": "people", "competency": "people", "skills": "people",
    "training": "people", "development": "people", "founder": "people",
    "dependency": "people", "key person": "people", "hire": "people",
    "culture": "people", "delegation": "people",
    "exit": "exit", "merger": "exit", "acquisition": "exit",
    "due diligence": "exit", "vdd": "exit", "buyers": "exit",
    "readiness": "exit", "preparing to sell": "exit",
    "sell my firm": "exit", "exit options": "exit",
    "what is my firm worth": "exit", "how much is my firm": "exit",
    "sales": "sales", "pipeline": "sales", "prospect": "sales",
    "opportunity": "sales", "capability": "sales", "outcome": "sales",
    "proposition": "sales", "closing": "sales", "negotiation": "sales",
    "networking": "sales", "results": "sales", "win rate": "sales",
    "marketing": "marketing", "brand": "marketing", "content": "marketing",
    "thought leadership": "marketing", "awareness": "marketing",
    "website": "marketing", "social media": "marketing", "advertising": "marketing",
    "client": "clients", "account": "clients",
    "retention": "clients", "satisfaction": "clients",
    "referral": "clients", "testimonial": "clients",
    "efficiency": "costs", "leverage": "costs",
    "utilisation": "costs", "utilization": "costs",
    "overhead": "costs", "overheads": "costs",
    "governance": "governance", "board": "governance", "leadership": "governance",
    "oversight": "governance", "accountability": "governance",
    "decision making": "governance",
    "delivery": "delivery", "implementation": "delivery",
    "execution": "delivery", "project management": "delivery",
    "value proposition": "strategy", "unique value": "strategy",
    "what makes my firm": "strategy", "why choose": "strategy",
    "unique selling point": "strategy", "usp": "strategy", "uvp": "strategy",
    "partner roles": "strategy", "partnership": "strategy",
    "critical success": "strategy", "success factors": "strategy",
    "less dependent": "people",
    "firm that doesn't need me": "people",
    "stay disciplined": "strategy",
    "shift from doing to solving": "sales",
    "kpi": "strategy",
    "risk": "strategy",
    "traits": "strategy",
}

CATEGORY_SPECIFICITY = {
    "pricing": 1, "people": 1, "exit": 2, "sales": 2,
    "strategy": 3, "marketing": 2, "clients": 2,
    "costs": 2, "governance": 2, "delivery": 2,
}

def detect_query_category(query):
    """Detect category with deterministic tie-breaking."""
    query_lower = query.lower()
    scores = {}
    for keyword, category in QUERY_CATEGORY_HINTS.items():
        if matches_keyword(keyword, query_lower):
            scores[category] = scores.get(category, 0) + 1
    if not scores:
        return None
    max_score = max(scores.values())
    candidates = [cat for cat, score in scores.items() if score == max_score]
    if len(candidates) == 1:
        return candidates[0]
    return min(candidates, key=lambda c: CATEGORY_SPECIFICITY.get(c, 10))


# --- Per-Document Topic Keywords ---

DOCUMENT_TOPICS = {
    "7 Layers of Consulting High Performance.md": ["layers", "performance", "pyramid", "value proposition", "discovery", "education", "seven layers", "high performance", "laser-sharp", "contextual", "client success"],
    "Managing Growth Inflection Points by Prof. Joe OMahoney - 6x9inch-print (1).pdf": ["growth", "inflection point", "plateau", "scaling", "adding services", "partner roles", "leadership roles", "critical success factors", "success factors", "traits", "characteristics"],
    "Reading - Strategy Chapter from O_Mahoney (2021) Growth.pdf": ["strategy", "competitive", "differentiation", "positioning"],
    "Distortion Layer How Consulting Firms Get Trapped.md": ["distortion", "trap", "specialisation", "focus", "FOMO", "ego", "fear"],
    "Consulting Value Proposition Quadrant.md": ["value proposition", "quadrant", "positioning", "differentiation", "UVP"],
    "Proposition Selling Path to High Performance.md": ["capability", "outcome", "selling", "skills", "results", "proposition"],
    "Three-Layer Consulting Value Proposition Model.md": ["value proposition", "three layer", "model", "framework"],
    "Consulting Value Proposition Canvas.md": ["value proposition", "canvas", "framework", "design"],
    "Strategy on a Page.md": ["strategy", "one page", "summary", "planning"],
    "UVP Template Exercise.md": ["UVP", "unique value", "template", "exercise"],
    "Positioning Statement Template.md": ["positioning", "statement", "template"],
    "Capability Led vs Outcome Led Value Proposition.md": ["capability", "outcome", "value proposition", "selling"],
    "Reading - eBook Pricing for Growth - A Guide for Consultancies.pdf": ["pricing models", "fee structure", "day rate", "blended rate", "charging", "how to price", "set fees", "rate card"],
    "Beyond the Billable Hour by Prof. Joe OMahoney.pdf": ["hourly billing", "alternative fee", "retainer", "value-based pricing", "not hourly", "fixed fee", "subscription", "recurring revenue"],
    "Advice - Pricing Masterclass (1).pdf": ["pricing", "strategy", "fee setting", "negotiation"],
    "Reading - 10-Golden-Rules-of-Pricing-Conversations.pdf": ["pricing", "golden rules", "conversation", "negotiation"],
    "Suggested Utilisation and Revenue by Grade.md": ["utilisation", "revenue", "grade", "benchmark"],
    "The Human Capital Engine by Prof. Joe OMahoney - A4 ebook (1) (1).pdf": ["human capital", "founder dependency", "key person", "talent", "people capability", "maturity"],
    "Reading - Good Competence Framework.pdf.pdf": ["competence", "competency", "framework", "levels", "skills", "junior consultant", "consultant", "senior", "manager", "partner", "career progression", "job titles", "roles"],
    "Consultant Bonus Scheme.md": ["bonus", "incentive", "scheme", "consultant"],
    "Senior Consultant Bonus Scheme.md": ["bonus", "incentive", "scheme", "senior"],
    "Motivation Matrix Partner Moves.md": ["motivation", "matrix", "partner", "moves"],
    "Organisational Design for Consultancies.md": ["organisational design", "structure", "consultancy"],
    "Reading - Supporting Senior Progression - Partner.md": ["progression", "partner", "senior", "career"],
    "The Boutique Consultancy M&A Playbook by Prof. Joe OMahoney.pdf": ["merger", "acquisition", "due diligence", "valuation", "exit"],
    "Reading - Creating The Exit Opportunity Final.pdf": ["exit", "sale", "valuation", "readiness"],
    "Reading - Private Equity and Consulting.pdf.pdf": ["private equity", "consulting", "investment"],
    "The Owners Guide to Exit by Prof. Joe OMahoney - A5_148x210mm-print (1).pdf": ["exit", "owner", "guide", "preparation"],
    "eBook - Preparing to sell your firm.docx.pdf.pdf": ["selling", "firm", "preparation", "exit"],
    "Exit options for consultancy owners v1.docx": ["exit options", "owner", "consultancy"],
    "Reading - Exit Options for a Boutique Owner.md": ["exit options", "boutique", "owner"],
    "Reading - Selling your firm.pdf": ["selling", "firm", "process"],
    "Reading - Words that close deals.pdf.md": ["closing", "deals", "negotiation", "sales"],
    "Reading - Stages to selling your firm.md": ["selling", "stages", "process", "exit"],
    "Proposition Selling Path to High Performance.md": ["capability", "outcome", "selling", "skills", "results", "proposition", "shift from", "doing to solving", "capability selling", "outcome selling"],
    "eBook - Account Based Marketing - Targeting the Big Fish by Prof. Joe OMahoney.pdf": ["account based marketing", "ABM", "targeting", "big fish"],
    "Strategic Account Management by Prof. Joe OMahoney (1).pdf": ["account management", "strategic", "client relationship"],
    "Using Thought Leadership to Boost Growth by Prof. Joe OMahoney (1).pdf": ["thought leadership", "growth", "boost"],
    "Reading - Sales Chapter from Joe_s Book _Growth_.pdf": ["sales", "chapter", "growth", "pipeline"],
    "Opportunity Ratings.md": ["opportunity", "rating", "scoring", "qualification"],
    "Pursuit Planning.md": ["pursuit", "planning", "strategy", "sales"],
    "Reading - Consultancy-Marketing-Now.pdf": ["marketing", "consultancy", "strategy"],
    "Reading - Headline-Hacks-for Blog and Content Writing.pdf": ["headline", "blog", "content", "writing"],
    "Marketing Strategy Framework.md": ["marketing", "strategy", "framework", "plan"],
    "Reading - Digital marketing 101 for Boutique Consultancies.pptx": ["digital marketing", "boutique", "basics"],
    "Governance Advice for PSFs.pdf": ["governance", "PSF", "professional service", "advice"],
    "eBook - Delegation by Prof. Joe OMahoney - 6x9inch-print (4).pdf": ["delegation", "empowerment", "handover"],
    "CEO Succession Planning Workshop.docx": ["succession", "CEO", "planning", "transition"],
    "Director Exit and Handover Checklist.pdf": ["exit", "handover", "director", "checklist"],
}

def get_category_boost(filename, file_path, query_category):
    """Conservative category boost (1.3x)."""
    if not query_category:
        return 1.0
    doc_category = infer_category(file_path)
    return 1.3 if doc_category == query_category else 1.0

def get_topic_boost(filename, query_topics):
    """Topic boost for same-category disambiguation."""
    doc_topics = DOCUMENT_TOPICS.get(filename, [])
    if not doc_topics or not query_topics:
        return 1.0
    matches = sum(1 for t in query_topics if any(t in dt for dt in doc_topics))
    if matches >= 3:
        return 1.5
    elif matches >= 2:
        return 1.3
    elif matches >= 1:
        return 1.1
    return 1.0


# --- List-Boost Detection ---

LIST_DOCUMENTS = {
    "Managing Growth Inflection Points by Prof. Joe OMahoney - 6x9inch-print (1).pdf": ["partner roles", "leadership roles", "critical success factors"],
    "7 Layers of Consulting High Performance.md": ["seven layers", "layers", "high performance"],
    "Reading - Good Competence Framework.pdf.pdf": ["competency levels", "career progression", "job titles"],
    "The Boutique Consultancy M&A Playbook by Prof. Joe OMahoney.pdf": ["due diligence", "exit process", "valuation methods"],
}

def detect_list_query(query):
    """Detect if query is asking for a list."""
    list_indicators = ['list', 'what are the', 'name the', 'enumerate', 'all the']
    return any(ind in query.lower() for ind in list_indicators)

def get_list_boost(filename, query):
    """Boost documents that contain lists when query asks for a list."""
    if not detect_list_query(query):
        return 1.0
    if filename in LIST_DOCUMENTS:
        for topic in LIST_DOCUMENTS[filename]:
            if topic in query.lower():
                return 1.5
        return 1.2
    return 1.0


def extract_query_topics(query):
    """Extract topic keywords from query."""
    words = re.findall(r'\b[a-z]{4,}\b', query.lower())
    stop_words = {'what', 'how', 'which', 'where', 'when', 'why', 'does', 'should',
                  'would', 'could', 'tell', 'about', 'from', 'with', 'that', 'this'}
    return [w for w in words if w not in stop_words]


# --- Simple Stemmer ---

EXPLICIT_STEMS = {
    "specialising": "specialis", "specialisation": "specialis",
    "specialize": "specialis", "specialization": "specialis",
    "specialized": "specialis", "specialises": "specialis",
    "dependent": "depend", "dependency": "depend", "dependence": "depend",
    "attractive": "attract", "attractiveness": "attract",
    "partnership": "partner", "partnerships": "partner", "partners": "partner",
    "plateau": "plateau", "plateaus": "plateau", "plateaued": "plateau",
    "blended": "blend", "blending": "blend",
    "diligence": "diligent",
    "systematise": "system", "systematize": "system", "systems": "system",
    "processes": "process", "procedures": "procedure",
    "scaling": "scale", "scaled": "scale",
    "growing": "grow", "growth": "grow", "grown": "grow",
    "metrics": "metric", "measures": "measure",
    "utilisation": "utilis", "utilization": "utilis",
    "organisation": "organis", "organization": "organis",
    "optimisation": "optimis", "optimization": "optimis",
}

SUFFIX_RULES = [
    ('isation', 'is'), ('ization', 'is'), ('ising', 'is'), ('izing', 'is'),
    ('ation', 'at'), ('tion', 't'), ('ment', ''), ('ness', ''),
    ('ies', 'y'), ('ied', 'y'), ('ing', ''), ('ful', ''),
    ('less', ''), ('able', ''), ('ible', ''), ('ive', ''),
    ('ly', ''), ('er', ''), ('ed', ''), ('es', ''), ('s', ''),
]

def stem_word(word):
    """Simple stemmer for English words."""
    word = word.lower().strip('.,?!;:\'"')
    if word in EXPLICIT_STEMS:
        return EXPLICIT_STEMS[word]
    for suffix, replacement in SUFFIX_RULES:
        if word.endswith(suffix) and len(word) - len(suffix) + len(replacement) >= 3:
            return word[:-len(suffix)] + replacement
    return word

def stem_phrase(phrase):
    """Stem all words in a phrase."""
    return " ".join(stem_word(w) for w in phrase.split())


def fuzzy_match(phrase, text, text_stemmed=None):
    """Check if phrase appears in text (with fuzzy matching)."""
    phrase_lower = phrase.lower()
    text_lower = text.lower()
    if phrase_lower in text_lower:
        return True
    phrase_stem = stem_phrase(phrase_lower)
    if text_stemmed is None:
        text_stemmed = " ".join(stem_word(w) for w in text_lower.split())
    if phrase_stem in text_stemmed:
        return True
    phrase_words = [w for w in phrase_lower.split() if len(w) > 3]
    if phrase_words:
        matches = sum(1 for w in phrase_words if w in text_lower)
        if matches >= len(phrase_words) * 0.7:
            return True
    return False


# --- Bidirectional Synonym Expansion ---

SYNONYM_PHRASES = {
    "specialising": ["specialisation", "specialize", "focus", "niche"],
    "specializing": ["specialise", "specialisation", "focus", "niche"],
    "specialisation": ["specialising", "specialize", "focus", "niche"],
    "specialization": ["specialising", "specialise", "focus", "niche"],
    "different": ["differentiation", "distinctive", "unique"],
    "differentiation": ["different", "distinctive", "unique"],
    "less dependent": ["founder dependency", "key person risk", "owner dependency"],
    "dependent on one person": ["founder dependency", "key person risk"],
    "dependent": ["dependency", "reliance"],
    "dependency": ["dependent", "reliance"],
    "reliance": ["dependent", "dependency"],
    "bottleneck": ["single point of failure", "founder dependency"],
    "fear of specialis": ["fear of specialisation", "fear of focus"],
    "traps": ["distortion layer", "barriers", "obstacles"],
    "unique selling point": ["value proposition", "UVP", "differentiation"],
    "usp": ["unique selling point", "value proposition"],
    "uvp": ["unique value proposition", "value proposition"],
    "what makes us different": ["value proposition", "differentiation"],
    "what makes my firm different": ["value proposition", "differentiation"],
    "why choose us": ["value proposition", "differentiation"],
    "competitive advantage": ["value proposition", "differentiation"],
    "sell skills": ["capability selling", "skill-based selling"],
    "sell results": ["outcome selling", "results-based selling"],
    "skills or results": ["capability vs outcome"],
    "capability": ["skills", "competence", "competency"],
    "outcome": ["result", "impact", "value delivered"],
    "blended day rate": ["pricing model", "fee structure", "day rate"],
    "day rate": ["blended rate", "daily rate", "pricing"],
    "how to price": ["pricing strategy", "fee setting"],
    "pricing": ["fees", "rates", "fee structure", "charging"],
    "fee": ["rate", "pricing", "charge"],
    "charge": ["fee", "rate", "pricing"],
    "revenue": ["income", "earnings", "top line"],
    "profit": ["margin", "profitability", "earnings"],
    "utilisation": ["utilization", "billable hours"],
    "utilization": ["utilisation", "billable hours"],
    "billable": ["billable hours", "utilisation"],
    "retainer": ["monthly fee", "ongoing fee"],
    "growth trap": ["inflection point", "plateau", "scaling challenge"],
    "plateau": ["stagnation", "flat growth", "inflection point"],
    "stagnation": ["plateau", "flat", "no growth"],
    "inflection point": ["plateau", "growth trap", "turning point"],
    "scale": ["growth", "scaling", "expand"],
    "scaling": ["growth", "scale", "expansion"],
    "growing": ["growth", "scaling", "expansion"],
    "adding services": ["service expansion", "diversification"],
    "systematise": ["systems", "processes", "standardise"],
    "systematize": ["systems", "processes", "standardize"],
    "not growing": ["plateau", "stagnation", "growth trap"],
    "stuck": ["plateau", "inflection point"],
    "due diligence": ["vendor due diligence", "VDD", "buyer assessment"],
    "vdd": ["vendor due diligence", "due diligence"],
    "partner roles": ["leadership roles", "governance roles"],
    "partnership": ["partners", "collaboration", "alliance"],
    "career pathway": ["career progression", "development path"],
    "attractive to buyers": ["exit readiness", "sale readiness"],
    "attractive": ["appeal", "desirable", "readiness"],
    "buyers": ["acquirers", "purchasers", "exit"],
    "risk": ["threat", "vulnerability", "hazard"],
    "threats": ["risks", "vulnerabilities"],
    "kpi": ["metrics", "indicators", "measures"],
    "metrics": ["KPI", "indicators", "measures"],
    "culture": ["values", "norms"],
    "values": ["culture", "principles"],
    "client relationship": ["account management", "client management"],
    "training": ["development", "skills pathway", "learning"],
    "leadership": ["management", "governance"],
    "governance": ["oversight", "control", "accountability"],
    "succession": ["transition", "handover"],
    "exit": ["sale", "departure", "transition"],
    "valuation": ["worth", "price", "assessment"],
    "acquisition": ["purchase", "takeover", "merger"],
    "merger": ["combination", "integration"],
    "alliance": ["partnership", "collaboration"],
    "traits": ["characteristics", "qualities", "attributes", "features"],
    "characteristics": ["traits", "qualities", "attributes"],
    "critical success": ["key success factors", "success factors", "CSF"],
    "success factors": ["critical success", "key factors"],
    "high performance": ["high-performing", "top performing", "best in class"],
    "roles": ["job titles", "positions", "functions", "responsibilities"],
    "job titles": ["roles", "positions", "functions"],
    "doing to solving": ["capability to outcome", "shift from doing", "proposition selling"],
    "shift from": ["transition from", "move from", "change from"],
    "sell skills": ["capability selling", "skill-based selling"],
    "sell results": ["outcome selling", "results-based selling"],
    "attractive to buyers": ["exit readiness", "sale readiness", "appeal to acquirers"],
    "buyers": ["acquirers", "purchasers", "exit", "sale"],
    "list": ["enumerate", "name", "what are"],
}


def expand_query(query):
    """Expand query with bidirectional synonyms, preserving phrase structure."""
    query_lower = query.lower()
    expanded_phrases = []
    stop_words = {'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
                  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
                  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
                  'on', 'with', 'at', 'by', 'from', 'as', 'and', 'but', 'or', 'not',
                  'no', 'so', 'yet', 'how', 'what', 'which', 'who', 'whom', 'where',
                  'when', 'why', 'if', 'then', 'else', 'this', 'that', 'i', 'me', 'my',
                  'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it',
                  'its', 'they', 'them', 'their', 'am'}
    
    words = re.findall(r'\b[a-z0-9]+\b', query_lower)
    meaningful = [w for w in words if w not in stop_words and (w.isdigit() or len(w) > 2)]
    for w in meaningful:
        expanded_phrases.append(w)
    for i in range(len(meaningful) - 1):
        expanded_phrases.append(f"{meaningful[i]} {meaningful[i+1]}")
    
    for key, synonyms in SYNONYM_PHRASES.items():
        if key in query_lower:
            for syn in synonyms:
                expanded_phrases.append(syn.lower())
                for w in syn.lower().split():
                    if w not in stop_words and len(w) > 2:
                        expanded_phrases.append(w)
        for syn in synonyms:
            if syn.lower() in query_lower:
                expanded_phrases.append(key.lower())
                for w in key.lower().split():
                    if w not in stop_words and len(w) > 2:
                        expanded_phrases.append(w)
                for other_syn in synonyms:
                    if other_syn.lower() != syn.lower():
                        expanded_phrases.append(other_syn.lower())
    
    seen = set()
    unique = []
    for p in expanded_phrases:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique


# --- Main Keyword Search ---

_all_docs_cache = {"t": 0.0, "data": None}


def keyword_phrase_search(query, collection, top_k=5):
    """Hybrid search with category + topic boosting and precomputed stems."""
    results = []
    seen_ids = set()
    
    query_category = detect_query_category(query)
    query_topics = extract_query_topics(query)
    print(f"[keyword] Category: {query_category}, Topics: {query_topics[:5]}")
    
    phrases = expand_query(query)
    if not phrases:
        return []
    print(f"[keyword] Expanded to {len(phrases)} phrases")
    
    common_words = {'keeps', 'consultancies', 'firm', 'what', 'how', 'why', 'make', 'list'}
    sorted_phrases = sorted(phrases, key=lambda p: (
        0 if ' ' in p and p not in common_words else
        1 if p not in common_words else
        2
    ))
    
    if _all_docs_cache["data"] is None or time.time() - _all_docs_cache["t"] > 60:
        _all_docs_cache["data"] = collection.get(include=["metadatas", "documents"])
        _all_docs_cache["t"] = time.time()
    all_docs = _all_docs_cache["data"]
    
    query_stems = {}
    for phrase in phrases:
        if len(phrase) > 2 and phrase not in common_words:
            stemmed = stem_phrase(phrase)
            weight = 1.0 if ' ' in phrase else 0.5
            if stemmed != phrase:
                query_stems[phrase] = (stemmed, weight)
            else:
                query_stems[phrase] = (phrase, weight)
    
    if query_stems:
        for i, doc in enumerate(all_docs["documents"]):
            doc_id = all_docs["ids"][i]
            if doc_id in seen_ids:
                continue
            stemmed_text = all_docs["metadatas"][i].get("stemmed_text", "")
            if not stemmed_text:
                stemmed_text = " ".join(stem_word(w) for w in doc.lower().split())
            doc_lower = doc.lower()
            matched = []
            total_weight = 0
            for phrase, (stemmed, weight) in query_stems.items():
                if fuzzy_match(phrase, doc_lower, stemmed_text):
                    matched.append(phrase)
                    total_weight += weight
            if matched:
                max_weight = sum(w for _, (_, w) in query_stems.items())
                score = (total_weight / max_weight) * 0.8 if max_weight > 0 else 0
                results.append({
                    "id": doc_id,
                    "file": all_docs["metadatas"][i].get("file_name", "?"),
                    "path": all_docs["metadatas"][i].get("file_path", "?"),
                    "text": doc,
                    "score": score,
                    "match": ", ".join(matched[:3]),
                    "source": "stemmed"
                })
    
    for r in results:
        cat_boost = get_category_boost(r["file"], r["path"], query_category)
        topic_boost = get_topic_boost(r["file"], query_topics)
        list_boost = get_list_boost(r["file"], query)
        r["score"] *= cat_boost * topic_boost * list_boost
    
    results.sort(key=lambda x: -x["score"])
    return results[:top_k]


# --- Document list (cached) ---

_doc_list_cache = None
_doc_list_cache_time = 0
_DOC_LIST_TTL = 300

def _get_document_list():
    """Get available documents for send_document tool."""
    global _doc_list_cache, _doc_list_cache_time
    if _doc_list_cache is not None and time.time() - _doc_list_cache_time < _DOC_LIST_TTL:
        return _doc_list_cache
    files = []
    for root, dirs, filenames in os.walk(DOCUMENTS_DIR):
        for f in filenames:
            if f.lower().endswith(('.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.png', '.jpg', '.jpeg')):
                rel_path = os.path.relpath(os.path.join(root, f), DOCUMENTS_DIR)
                files.append(rel_path)
    _doc_list_cache = sorted(files)
    _doc_list_cache_time = time.time()
    return _doc_list_cache


def _load_retriever():
    global _retriever
    with _index_lock:
        chroma_client = get_chroma_client()
        try:
            chroma_collection = chroma_client.get_collection("professor_docs")
        except Exception:
            _retriever = None
            return
        vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
        storage_context = StorageContext.from_defaults(
            persist_dir=STORAGE_DIR, vector_store=vector_store,
        )
        index = load_index_from_storage(storage_context)
        _retriever = VectorIndexRetriever(index=index, similarity_top_k=50)


def reload():
    global _doc_list_cache, _doc_list_cache_time
    _load_retriever()
    _doc_list_cache = None
    _doc_list_cache_time = 0


def get_chroma_write_lock():
    return _chroma_write_lock


# =============================================================================
# TOOL EXECUTION
# =============================================================================

def _execute_search(query):
    """Execute RAG search — called when LLM invokes search_documents tool.
    
    Note: LLM sometimes passes non-string args (int, dict etc). Always coerce.
    """
    query = str(query) if query else ""
    if _retriever is None:
        return "Search unavailable — knowledge base not loaded."
    
    # Expand query with synonyms
    expanded_queries = expand_query(query)
    print(f"[SEARCH] Query: {query[:60]} | Expanded: {len(expanded_queries)} phrases")
    
    # Semantic search
    semantic_nodes = []
    seen_ids = set()
    for eq in expanded_queries[:5]:  # Limit expansion to avoid too many searches
        nodes = _retriever.retrieve(eq)
        for node in nodes:
            node_id = node.node.text[:100]
            if node_id not in seen_ids:
                seen_ids.add(node_id)
                semantic_nodes.append(node)
    
    # Keyword search
    collection = get_chroma_client().get_collection("professor_docs")
    keyword_results = []
    for eq in expanded_queries[:5]:
        kr = keyword_phrase_search(eq, collection, top_k=10)
        for r in kr:
            if r["id"] not in seen_ids:
                seen_ids.add(r["id"])
                keyword_results.append(r)
    
    # Merge candidates
    all_candidates = []
    seen_text = set()
    
    for node in semantic_nodes[:30]:
        text_key = node.node.text[:100]
        if text_key not in seen_text:
            seen_text.add(text_key)
            all_candidates.append({
                "file": node.node.metadata.get("file_name", "?"),
                "page": node.node.metadata.get("page_label", "N/A"),
                "text": node.node.text,
                "source": "semantic"
            })
    
    for kr in keyword_results[:10]:
        text_key = kr["text"][:100]
        if text_key not in seen_text:
            seen_text.add(text_key)
            all_candidates.append({
                "file": kr["file"],
                "page": "N/A",
                "text": kr["text"],
                "source": "keyword"
            })
    
    # Rerank
    if _reranker and all_candidates:
        from llama_index.core.schema import NodeWithScore, TextNode
        rerank_nodes = []
        for c in all_candidates:
            node = TextNode(text=c["text"][:500], metadata={"file_name": c["file"], "page_label": c["page"]})
            rerank_nodes.append(NodeWithScore(node=node, score=1.0))
        
        qb = QueryBundle(query_str=query)
        reranked = _reranker.postprocess_nodes(rerank_nodes, qb)
        
        reranked_texts = [n.node.text[:100] for n in reranked]
        reranked_scores = [float(n.score) for n in reranked]
        
        for c in all_candidates:
            text_key = c["text"][:100]
            if text_key in reranked_texts:
                idx = reranked_texts.index(text_key)
                c["rerank_score"] = reranked_scores[idx]
            else:
                c["rerank_score"] = -1.0
        
        all_candidates.sort(key=lambda x: x["rerank_score"], reverse=True)
    else:
        for c in all_candidates:
            c["rerank_score"] = 0.0
    
    # Format results for LLM
    results = []
    for c in all_candidates[:6]:  # Top 6 results — more context for multi-chunk documents
        results.append({
            "file": c["file"],
            "page": c["page"],
            "text": c["text"][:1500],  # Enough for most documents without truncation
            "score": c.get("rerank_score", 0),
            "source": c["source"]
        })
    
    if not results:
        return "No relevant information found in Joe's documents."
    
    # Format as structured text for LLM
    formatted = []
    for i, r in enumerate(results):
        formatted.append(f"[{i+1}] File: \"{r['file']}\" (Page: {r['page']})\n{r['text']}")
    
    print(f"[SEARCH] Returned {len(results)} results")
    return "\n\n".join(formatted)


def _execute_send_document(filename):
    """Execute send_document — called when LLM invokes send_document tool."""
    doc_list = _get_document_list()
    
    # Fuzzy match filename
    filename_lower = filename.lower()
    for doc in doc_list:
        if filename_lower in doc.lower() or doc.lower() in filename_lower:
            return f"send_file:{doc}"
    
    # Try partial match — at least 1 word overlap
    for doc in doc_list:
        doc_words = set(re.findall(r'[a-z]{3,}', doc.lower()))
        query_words = set(filename_lower.split())
        if len(doc_words & query_words) >= 1:
            return f"send_file:{doc}"
    
    return f"Document '{filename}' not found. Available documents: {', '.join(doc_list[:10])}..."


# =============================================================================
# LLM TOOL CALLING
# =============================================================================

def _llm_with_tools(messages, tools=None):
    """Send messages to LLM with tool definitions via OpenAI-compatible API."""
    if tools is None:
        tools = TOOLS
    
    payload = {
        "model": LLAMA_MODEL,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.7,
        "max_tokens": 2048,
    }
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {LLAMA_API_KEY}",
    }
    
    try:
        response = requests.post(
            f"{LLAMA_SWAP_URL}/v1/chat/completions",
            json=payload,
            headers=headers,
            timeout=120,
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"[LLM] Error: {e}")
        return None


def _extract_tool_calls(response):
    """Extract tool calls from LLM response."""
    if not response:
        return []
    
    choices = response.get("choices", [])
    if not choices:
        return []
    
    message = choices[0].get("message", {})
    return message.get("tool_calls", [])


def _extract_content(response):
    """Extract content from LLM response."""
    if not response:
        return ""
    
    choices = response.get("choices", [])
    if not choices:
        return ""
    
    message = choices[0].get("message", {})
    return message.get("content", "")


def _strip_attribution(text):
    """Minimal safety net — prompt does the heavy lifting.
    Only catches leading attribution phrases. Does NOT strip mid-sentence content."""
    if not text:
        return text
    
    # Strip Gemma-4 thinking tags (<|channel>thought\n<channel|>...answer...)
    text = re.sub(r'<\|channel>thought\n<channel\|>\n?', '', text)
    text = re.sub(r'<\|channel>.*?<channel\|>\n?', '', text, flags=re.DOTALL)
    
    # Only strip leading attribution openers (start of answer)
    text = re.sub(r'^[Aa]ccording to [Pp]rofessor [Jj]oe,\s*', '', text)
    text = re.sub(r'^[Bb]ased on [Jj]oe\'s (?:work|research),\s*', '', text)
    text = re.sub(r'^[Bb]ased on the (?:search )?results,\s*', '', text)
    text = re.sub(r'^[Tt]he (?:search )?results (?:suggest|indicate|show) that\s*', '', text)
    
    # Style cleanup
    text = re.sub(r'\s{2,}', ' ', text)
    text = re.sub(r'^\s*,\s*', '', text)
    text = text.strip()
    
    return text


def _markdown_to_whatsapp(text):
    """Convert Markdown output to WhatsApp-compatible formatting."""
    if not text:
        return text

    # Pass 1: ensure newlines around headings
    # "text. ## Heading body" → "text.\n## Heading body"
    text = re.sub(r'(?<!\n)(#{1,6}\s)', r'\n\1', text)
    # "## Heading body\n" → "## Heading\nbody\n" (split heading from inline body)
    text = re.sub(r'^(#{1,6}\s+[^\n]+?)(\s{2,})', r'\1\n', text, flags=re.MULTILINE)
    # Pass 2: convert headings to bold on own lines
    text = re.sub(r'^#{1,6}\s+(.+)$', r'\n\1\n', text, flags=re.MULTILINE)

    # Bold: strip all * markers — LLM output is too inconsistent to convert
    # Headings and bullets are the priority; bold is cosmetic
    text = re.sub(r'\*+', '', text)

    # Italic: _text_ or *text* (single) — keep as-is, WhatsApp renders *text* as bold
    # We only convert double-star bold above. Single * stays.

    # Bullet on own line: ensure \n before every bullet
    text = re.sub(r'(?<!\n) • ', '\n• ', text)

    # Clean up: max 2 consecutive newlines
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()

    return text
def _extract_sources(messages):
    """Extract source files from tool results in messages."""
    sources = []
    for msg in messages:
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            # Parse file references from search results
            import re
            file_matches = re.findall(r'File: "([^"]+)"', content)
            for f in file_matches:
                if f not in sources:
                    sources.append(f)
    return sources


# =============================================================================
# MAIN QUERY FUNCTION
# =============================================================================

async def query_rag(question, history=None):
    """Main query endpoint — tool-calling architecture.
    
    Flow:
    1. Build messages with conversation history
    2. Send to LLM with tool definitions
    3. If LLM calls tool, execute and send results back
    4. Repeat until LLM gives final answer
    5. Return answer with sources
    """
    if history is None:
        history = []
    
    # Build messages
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    
    # Add conversation history (last 20 messages)
    for h in history[-20:]:
        role = h.get("role", "user")
        content = h.get("text", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    
    # Add current question
    messages.append({"role": "user", "content": question})
    
    # Tool calling loop (max 3 iterations to prevent infinite loops)
    max_iterations = 3
    sources = []
    
    for iteration in range(max_iterations):
        print(f"[TOOL_LOOP] Iteration {iteration + 1}")
        
        # Send to LLM with tools
        response = await asyncio.to_thread(_llm_with_tools, messages)
        
        if not response:
            return {
                "answer": "I'm having trouble connecting to the model. Please try again.",
                "sources": [],
                "offer_file": None,
            }
        
        # Check for tool calls
        tool_calls = _extract_tool_calls(response)
        
        if not tool_calls:
            # No tool calls — LLM gave final answer
            content = _extract_content(response)
            sources = _extract_sources(messages)
            
            # Post-filter: strip attribution language
            content = _strip_attribution(content)
            
            # Convert Markdown to WhatsApp formatting
            content = _markdown_to_whatsapp(content)
            
            return {
                "answer": content,
                "sources": [{"file_name": s, "page_label": "N/A", "score": 1.0} for s in sources],
                "offer_file": sources[0] if sources else None,
            }
        
        # Execute tool calls
        assistant_message = response["choices"][0]["message"]
        messages.append(assistant_message)
        
        for tool_call in tool_calls:
            function_name = tool_call["function"]["name"]
            arguments = json.loads(tool_call["function"]["arguments"])
            tool_call_id = tool_call["id"]
            
            print(f"[TOOL_CALL] {function_name}({arguments})")
            
            if function_name == "search_documents":
                result = await asyncio.to_thread(_execute_search, arguments.get("query", ""))
            elif function_name == "send_document":
                result = _execute_send_document(arguments.get("filename", ""))
                # send_document returns "send_file:..." — return immediately
                if result.startswith("send_file:"):
                    sources = _extract_sources(messages)
                    return {
                        "answer": result,
                        "sources": [{"file_name": s, "page_label": "N/A", "score": 1.0} for s in sources],
                        "offer_file": result.split("send_file:", 1)[1],
                    }
            else:
                result = f"Unknown tool: {function_name}"
            
            # Add tool result to messages
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": result,
            })
    
    # If we hit max iterations, force synthesis
    messages.append({"role": "user", "content": "You have enough information from the search results. Please answer the question now."})
    response = await asyncio.to_thread(_llm_with_tools, messages)
    content = _extract_content(response) if response else ""
    
    if not content:
        content = "I found relevant information but couldn't synthesize an answer. Please try rephrasing your question."
    
    # Convert Markdown to WhatsApp formatting
    content = _markdown_to_whatsapp(content)
    
    sources = _extract_sources(messages)
    
    return {
        "answer": content,
        "sources": [{"file_name": s, "page_label": "N/A", "score": 1.0} for s in sources],
        "offer_file": sources[0] if sources else None,
    }


# =============================================================================
# INITIALIZATION
# =============================================================================

try:
    _load_retriever()
except Exception as e:
    import logging
    logging.getLogger(__name__).warning(f"Initial index load failed (non-fatal): {e}")
