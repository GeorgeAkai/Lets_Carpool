from backend.app.main import create_app

app = create_app()  # noqa: F401  — Vercel looks for `app`
