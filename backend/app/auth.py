from __future__ import annotations

from datetime import UTC, datetime, timedelta

import jwt

from backend.app.domain import DomainError


def create_access_token(*, user_id: str, email: str, secret: str, expires_minutes: int) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "email": email,
        "iat": now,
        "exp": now + timedelta(minutes=expires_minutes),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_access_token(token: str, secret: str) -> str:
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError as exc:
        raise DomainError("Token has expired", 401) from exc
    except jwt.InvalidTokenError as exc:
        raise DomainError("Invalid or expired token", 401) from exc
    user_id = payload.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise DomainError("Invalid or expired token", 401)
    return user_id
