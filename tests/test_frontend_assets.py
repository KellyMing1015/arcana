"""Check the actual deployed frontend graph, including its new styles and imagery."""
import re
import unittest
from urllib.parse import urlsplit

import app as website


class FrontendAssetsTests(unittest.TestCase):
    def test_page_modules_styles_and_local_images_are_served(self):
        client = website.app.test_client()
        paths = {"/", "/app.js?v=20261011-reconnect"}
        visited = set()
        patterns = (
            r'''(?:href|src)=["']([^"']+)["']''',
            r'''(?:from\s+|import\s*)["']([^"']+)["']''',
            r'''url\(\s*["']?([^\s)"']+)["']?\s*\)''',
        )
        while paths:
            path = paths.pop()
            if path in visited:
                continue
            visited.add(path)
            response = client.get(path)
            self.assertEqual(response.status_code, 200, path)
            clean_path = urlsplit(path).path
            self.assertNotIn(response.mimetype, {"application/json", "text/plain"}, path)
            if clean_path == "/" or clean_path.endswith((".html", ".js", ".css")):
                text = response.get_data(as_text=True)
                for pattern in patterns:
                    for ref in re.findall(pattern, text):
                        if ref.startswith(("/assets/", "./")) and "${" not in ref:
                            paths.add(ref[1:] if ref.startswith("./") else ref)
            response.close()
        for required in ("/home-view.js?v=20261011-reconnect", "/flow.css?v=20261011-reconnect",
                         "/assets/ui/observatory-moon.svg", "/assets/ui/card-back-engraved.webp?v=20261006-images&w=480",
                         "/assets/ui/starfield-night-sparse.webp?v=20261006-images"):
            self.assertIn(required, visited)
        # Different URLs instantiate separate modules and split account/profile state.
        modules = [path for path in visited if urlsplit(path).path.endswith(".js")]
        self.assertTrue(all(urlsplit(path).query == "v=20261011-reconnect" for path in modules), modules)
        self.assertEqual(len(modules), len({urlsplit(path).path for path in modules}))

    def test_source_preview_and_private_data_are_not_public(self):
        client = website.app.test_client()
        for path in ("/serve.py", "/qa.html", "/qa-app.js", "/preview.db", "/arcana.db", "/.env",
                     "/assets/ui/../../arcana.db"):
            with client.get(path) as response:
                self.assertEqual(response.status_code, 404, path)

    def test_entry_page_versions_styles_and_uses_the_production_port(self):
        with website.app.test_client().get("/") as response:
            page = response.get_data(as_text=True)
        styles = re.findall(r'href="(\./[^"\s]+\.css[^"\s]*)"', page)
        self.assertEqual(len(styles), 7)
        self.assertTrue(all("?v=20261011-reconnect" in href for href in styles))
        self.assertIn('script.src = "./app.js?v=20261011-reconnect"', page)
        self.assertIn("127.0.0.1:4173", page)
        self.assertNotIn("127.0.0.1:4187", page)
