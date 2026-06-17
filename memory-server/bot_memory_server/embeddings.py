from sentence_transformers import SentenceTransformer

_model: SentenceTransformer | None = None

MODEL_NAME = "all-MiniLM-L6-v2"
DIMENSIONS = 384


def load_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_NAME)
    return _model


def embed(text: str) -> list[float]:
    model = load_model()
    return model.encode(text).tolist()
