"""Client library behind bb.py, split by responsibility:

    errors.py     BBError and the error codes the skill translates
    config.py     ~/.bb/config.json + environment, working-context state
    transport.py  HTTP: auth header, timeouts, status -> error mapping, redacted logging
    api.py        one method per verified brewboard_backend.api.* endpoint (no others)
    service.py    the /bb operations: validation, filters, normalised output shapes
    render.py     Markdown tables for the agent to print verbatim

Standard library only (Python 3.8+), so it runs wherever the coding agent runs.
"""
