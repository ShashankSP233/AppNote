"""Self-hosted invoice extraction service.

Runs independently of AppNote. It reads an invoice (searchable PDF text first,
OCR for scans and images), asks a local Ollama model to copy the printed values
into a fixed JSON schema, and then validates every value against the document
text before returning it. Nothing it returns is verified; a person reviews it.
"""

__version__ = "1.0.0"
API_VERSION = "v1"
SCHEMA_VERSION = "invoice-extraction.v1"
