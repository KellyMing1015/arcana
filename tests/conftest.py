"""Keep pytest's application import away from the real database and model keys.

Use the real cryptography dependency from requirements.txt: a plaintext stub
cannot verify encryption or authentication of stored account settings.
"""
import atexit
import os
import tempfile

_bootstrap = tempfile.TemporaryDirectory(prefix="arcana-test-bootstrap-")
atexit.register(_bootstrap.cleanup)
os.environ["ARCANA_DATABASE"] = os.path.join(_bootstrap.name, "arcana.db")
for name in ("ARCANA_MEMORY_MODEL_BASE_URL", "ARCANA_MEMORY_MODEL_API_KEY", "ARCANA_MEMORY_MODEL"):
    os.environ[name] = ""
