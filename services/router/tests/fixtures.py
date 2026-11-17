"""Recorded provider /models responses (trimmed from real responses, Nov 2026)."""

GROQ_MODELS = {
    "object": "list",
    "data": [
        {
            "id": "openai/gpt-oss-120b",
            "object": "model",
            "owned_by": "OpenAI",
            "active": True,
            "context_window": 131072,
            "max_completion_tokens": 65536,
            "input_modalities": ["text"],
            "output_modalities": ["text"],
            "pricing": {"prompt": "0.00000015", "completion": "0.0000006"},
        },
        {
            "id": "qwen/qwen3.8-27b",
            "object": "model",
            "owned_by": "Alibaba Cloud",
            "active": True,
            "context_window": 131072,
            "max_completion_tokens": 16384,
            "input_modalities": ["text", "image"],
            "output_modalities": ["text"],
        },
        {
            "id": "whisper-large-v3",
            "object": "model",
            "owned_by": "OpenAI",
            "active": True,
            "context_window": 448,
            "input_modalities": ["audio"],
            "output_modalities": ["text"],
        },
        {"id": "allam-2-7b", "object": "model", "owned_by": "SDAIA", "active": False, "context_window": 4096},
    ],
}

CEREBRAS_MODELS = {
    "object": "list",
    "data": [
        {"id": "gpt-oss-120b", "object": "model", "owned_by": "Cerebras"},
        {"id": "some-new-model", "object": "model", "owned_by": "Cerebras"},
    ],
}

GEMINI_PAGE_1 = {
    "models": [
        {
            "name": "models/gemini-3.5-flash",
            "displayName": "Gemini 3.5 Flash",
            "inputTokenLimit": 1048576,
            "outputTokenLimit": 65536,
            "supportedGenerationMethods": ["generateContent", "countTokens"],
        },
        {
            "name": "models/gemini-embedding-2",
            "displayName": "Gemini Embedding 2",
            "inputTokenLimit": 8192,
            "supportedGenerationMethods": ["embedContent"],
        },
    ],
    "nextPageToken": "p2",
}
GEMINI_PAGE_2 = {
    "models": [
        {
            "name": "models/gemini-2.5-computer-use-preview-10-2025",
            "displayName": "Computer Use",
            "inputTokenLimit": 131072,
            "supportedGenerationMethods": ["generateContent"],
        },
    ]
}

OPENROUTER_MODELS = {
    "data": [
        {
            "id": "openai/gpt-oss-120b:free",
            "name": "OpenAI: gpt-oss-120b (free)",
            "context_length": 131072,
            "pricing": {"prompt": "0", "completion": "0"},
            "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
            "top_provider": {"max_completion_tokens": 32768},
            "expiration_date": None,
        },
        {
            "id": "tencent/hy4-flash",
            "name": "Tencent: Hy4 flash",
            "context_length": 1048576,
            "pricing": {"prompt": "0.000000035", "completion": "0.0000001405"},
            "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
            "top_provider": {"max_completion_tokens": 65536},
            "expiration_date": "2026-12-31",
        },
    ]
}

ZEN_MODELS = {
    "object": "list",
    "data": [
        {
            "id": "big-pickle",
            "name": "Big Pickle",
            "type": "chat",
            "family": "big-pickle",
            "capabilities": {"tools": {"supported": True}, "reasoning": {"supported": True}},
            "cost": {"text": {"input": {"price": 0}, "output": {"price": 0}}},
            "limit": {"context": 200000, "output": 32000},
            "modalities": {"input": ["text"], "output": ["text"]},
        },
        {
            "id": "claude-sonnet-5-5",
            "name": "Claude Sonnet 5.5",
            "type": "chat",
            "capabilities": {"reasoning": {"supported": True}},
            "cost": {"text": {"input": {"price": 3}, "output": {"price": 15}}},
            "limit": {"context": 1000000, "output": 64000},
            "modalities": {"input": ["text", "image/png"], "output": ["text"]},
        },
    ],
}

OLLAMA_TAGS = {
    "models": [
        {
            "name": "qwen3:4b",
            "details": {"family": "qwen3", "parameter_size": "4.0B", "quantization_level": "Q4_K_M"},
        },
        {"name": "mystery:1b", "details": {"family": "x"}},
    ]
}
