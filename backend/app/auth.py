from __future__ import annotations

from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import jwt

from backend.app.domain import DomainError

# Supabase Auth signs access tokens either asymmetrically (ES256/RS256/EdDSA,
# public keys published at a JWKS endpoint) or, on legacy projects, with a shared
# HS256 secret. Both are supported; the JWKS path is used unless a secret is set.
SUPABASE_JWT_ALGORITHMS = ["ES256", "RS256", "EdDSA"]


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    # Cached per URL so the JWKS document isn't re-fetched on every request;
    # PyJWKClient also caches the individual signing keys it resolves.
    return jwt.PyJWKClient(jwks_url, cache_keys=True)


def verify_supabase_token(
    token: str, *, jwks_url: str | None, hs256_secret: str | None,
    issuer: str | None, audience: str | None,
) -> dict[str, Any]:
    """Cryptographically verifies a Supabase Auth access token.

    Raises DomainError(401) for any invalid, unsigned, expired, or wrong-issuer/
    audience token — this must never fall back to trusting an unverified claim.
    """
    try:
        if hs256_secret:
            key: Any = hs256_secret
            algorithms = ["HS256"]
        elif jwks_url:
            key = _jwks_client(jwks_url).get_signing_key_from_jwt(token).key
            algorithms = SUPABASE_JWT_ALGORITHMS
        else:
            raise DomainError("Server is not configured with SUPABASE_URL", 500)
        # PyJWT raises InvalidAudienceError if a token carries `aud` but no
        # expected audience was given; verify_aud=False is its way to opt out.
        options: dict[str, Any] = {"require": ["exp", "sub"]}
        if audience is None:
            options["verify_aud"] = False
        payload = jwt.decode(
            token, key, algorithms=algorithms, issuer=issuer, audience=audience, options=options,
        )
    except jwt.PyJWKClientError as exc:
        raise DomainError("Could not verify token signature", 401) from exc
    except jwt.ExpiredSignatureError as exc:
        raise DomainError("Token has expired", 401) from exc
    except jwt.InvalidTokenError as exc:
        raise DomainError("Invalid token", 401) from exc
    return payload


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
