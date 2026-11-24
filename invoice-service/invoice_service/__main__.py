"""Entry point:  python -m invoice_service"""

from __future__ import annotations

import logging
import os
import sys

from .config import ConfigError, Settings, load_env_file


def main() -> int:
    load_env_file(os.environ.get("INVOICE_SERVICE_ENV_FILE", ".env"))
    try:
        settings = Settings.from_env()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("invoice_service")
    for note in settings.startup_warnings():
        log.warning(note)

    from waitress import serve

    from .app import create_app

    app = create_app(settings)
    log.info("Invoice extraction service %s listening on %s:%s (model %s, concurrency %s)",
             "v1", settings.host, settings.port, settings.model, settings.max_concurrency)
    serve(
        app,
        host=settings.host,
        port=settings.port,
        threads=settings.max_concurrency + 4,       # spare threads keep /v1/health responsive
        channel_timeout=int(settings.request_timeout_s) + 60,
        max_request_body_size=settings.max_upload_bytes + 1024 * 1024,
        ident="invoice-service",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
