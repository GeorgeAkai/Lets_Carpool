from __future__ import annotations

from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import jwt

from backend.app.domain import DomainError

# Supabase Auth signs access tokens either asymmetrically (ES256/RS256, the
# default for current projects, with public keys published at a JWKS endpoint)
# or, on projects still using the legacy shared secret, with HS256. Only the
# asymmetric algorithms are ever accepted against the JWKS keys, and HS256 only
# against the configured secret — never a mix, so a token can't pick its own
# verification path (the classic alg-confusion attack).
SUPABASE_JWKS_ALGORITHMS = ["ES256", "RS256", "EdDSA"]
SUPABASE_LEGACY_ALGORITHM = "HS256"


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    # Cached per URL so the JWKS document isn't re-fetched on every request;
    # PyJWKClient also caches the individual signing keys it resolves.
    return jwt.PyJWKClient(jwks_url, cache_keys=True)


def verify_supabase_token(
    token: str, *, jwks_url: str, jwt_secret: str | None, issuer: str | None, audience: str | None,
) -> dict[str, Any]:
    """Cryptographically verifies a Supabase Auth access token.

    Raises DomainError(401) for any invalid, unsigned, expired, or wrong-issuer/
    audience token — this must never fall back to trusting an unverified claim.
    """
    # PyJWT raises InvalidAudienceError when a token carries `aud` but no
    # expected audience is passed, so opting out has to be explicit.
    options: dict[str, Any] = {"require": ["exp", "sub"]}
    if audience is None:
        options["verify_aud"] = False
    try:
        alg = jwt.get_unverified_header(token).get("alg")
        if alg == SUPABASE_LEGACY_ALGORITHM:
            if not jwt_secret:
                raise DomainError("Server is not configured with SUPABASE_JWT_SECRET for HS256 tokens", 401)
            key: Any = jwt_secret
            algorithms = [SUPABASE_LEGACY_ALGORITHM]
        else:
            key = _jwks_client(jwks_url).get_signing_key_from_jwt(token).key
            algorithms = SUPABASE_JWKS_ALGORITHMS
        payload = jwt.decode(
            token, key, algorithms=algorithms, issuer=issuer, audience=audience, options=options,
        )
    except jwt.PyJWKClientError as exc:
        raise DomainError("Could not verify sign-in token signature", 401) from exc
    except jwt.ExpiredSignatureError as exc:
        raise DomainError("Sign-in token has expired", 401) from exc
    except jwt.InvalidTokenError as exc:
        raise DomainError("Invalid sign-in token", 401) from exc
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
