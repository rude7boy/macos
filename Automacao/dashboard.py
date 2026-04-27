#!/usr/bin/env python3
import sys

try:
    from app.dashboard import create_app
except ImportError as exc:
    print(f"Dependencia ausente: {exc}. Execute: pip install -r requirements.txt")
    sys.exit(1)

app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
