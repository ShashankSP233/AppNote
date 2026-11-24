"""API errors. Every failure the service can report has a stable code."""

from __future__ import annotations


class ApiError(Exception):
    status = 500
    code = "internal_error"

    def __init__(self, message: str, *, retry_after: int | None = None):
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after


class InvalidRequest(ApiError):
    status = 400
    code = "invalid_request"


class Unauthorized(ApiError):
    status = 401
    code = "unauthorized"


class FileTooLarge(ApiError):
    status = 413
    code = "file_too_large"


class UnsupportedMediaType(ApiError):
    status = 415
    code = "unsupported_media_type"


class InvalidDocument(ApiError):
    """The file is a PDF/image by signature but cannot be opened or decoded."""

    status = 422
    code = "invalid_document"


class NoReadableText(ApiError):
    """No usable text could be obtained from the document."""

    status = 422
    code = "no_readable_text"


class Busy(ApiError):
    status = 429
    code = "busy"


class OcrUnavailable(ApiError):
    status = 503
    code = "ocr_unavailable"


class ModelUnavailable(ApiError):
    status = 503
    code = "model_unavailable"


class ModelInvalidOutput(ApiError):
    status = 502
    code = "model_invalid_output"


class ModelTimeout(ApiError):
    status = 504
    code = "model_timeout"


class OcrTimeout(ApiError):
    status = 504
    code = "ocr_timeout"


class RequestTimeout(ApiError):
    status = 504
    code = "request_timeout"


ERROR_CODES = {
    cls.code: cls.status
    for cls in (
        InvalidRequest, Unauthorized, FileTooLarge, UnsupportedMediaType,
        InvalidDocument, NoReadableText, Busy, OcrUnavailable, ModelUnavailable,
        ModelInvalidOutput, ModelTimeout, OcrTimeout, RequestTimeout, ApiError,
    )
}
