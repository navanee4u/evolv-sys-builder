"""Test isolation: redirect Anvil's persistent memory to a throwaway temp dir so
distilled rules / failure logs don't leak between runs or pollute the real
memory/ directory used by the live demo."""

import os
import tempfile
import pathlib

import pytest


@pytest.fixture(autouse=True)
def _isolated_memory(monkeypatch):
    d = tempfile.mkdtemp(prefix="anvil-mem-")
    monkeypatch.setenv("ANVIL_MEM_DIR", d)
    monkeypatch.setenv("ANVIL_DATA_DIR", tempfile.mkdtemp(prefix="anvil-data-"))
    yield
    # best-effort cleanup
    for f in pathlib.Path(d).glob("*"):
        try:
            f.unlink()
        except OSError:
            pass
