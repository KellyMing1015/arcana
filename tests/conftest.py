"""Stub cryptography for test environments where it cannot be compiled."""
import sys
import types
import importlib.machinery

if "cryptography" not in sys.modules:
    crypto = types.ModuleType("cryptography")
    crypto.__spec__ = importlib.machinery.ModuleSpec("cryptography", None)
    fernet = types.ModuleType("cryptography.fernet")
    fernet.__spec__ = importlib.machinery.ModuleSpec("cryptography.fernet", None)

    class _FakeFernet:
        def __init__(self, key):
            pass
        def encrypt(self, data):
            return data
        def decrypt(self, data):
            return data

    fernet.Fernet = _FakeFernet
    fernet.InvalidToken = Exception
    crypto.fernet = fernet
    sys.modules["cryptography"] = crypto
    sys.modules["cryptography.fernet"] = fernet
