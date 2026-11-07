"""Static-site checks: pricing matches plans.py, no broken local links, generated pages fresh."""
import html
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONT = ROOT / "frontend"
sys.path.insert(0, str(ROOT))

from plans import PLANS  # noqa: E402


def _plan_block(src: str, plan_id: str) -> str:
    m = re.search(rf'<div class="plan[^"]*" data-plan="{plan_id}">(.*?)\n      </div>', src, re.S)
    assert m, f"plan {plan_id} not found in pricing.html"
    return m.group(1)


def test_pricing_page_matches_plan_catalogue():
    src = (ROOT / "site_src" / "pricing.html").read_text()
    for plan in PLANS:
        block = _plan_block(src, plan["id"])
        items = [html.unescape(re.sub(r"<[^>]+>", "", li)).strip() for li in re.findall(r"<li>(.*?)</li>", block)]
        assert items == plan["features"], f"{plan['id']} features differ from plans.py"
        if plan["monthly"]:
            assert f'data-monthly="{plan["monthly"]}"' in block
            assert f'data-yearly="{round(plan["yearly"] / 12)}"' in block
            assert f'billed ${plan["yearly"]} yearly' in block


def test_no_broken_local_links():
    broken = []
    for page in FRONT.rglob("*.html"):
        text = page.read_text()
        base = FRONT if "<base " in text else page.parent
        for ref in re.findall(r'(?:href|src)="([^"#?]+)', text):
            if re.match(r"^(https?:|mailto:|data:|javascript:|\[)", ref) or ref.startswith("${"):
                continue
            target = (base / ref.lstrip("/")).resolve() if not ref.startswith("/") else (FRONT / ref.split("/", 2)[-1]).resolve()
            if not target.exists():
                broken.append(f"{page.relative_to(FRONT)} → {ref}")
    assert not broken, "Broken local links:\n" + "\n".join(broken)


def test_generated_pages_are_fresh():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_site.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_app_loads_modules_in_order():
    app = (FRONT / "app.html").read_text()
    order = [app.index(s) for s in ['js/config.js', 'js/core.js', '"app.js"', 'js/billing.js', 'js/live.js', 'js/onboarding.js']]
    assert order == sorted(order)
