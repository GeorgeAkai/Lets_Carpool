from __future__ import annotations

from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import jwt

from backend.app.domain import DomainError

# Neon Auth (better-auth's JWT plugin) signs session tokens asymmetrically and
# publishes the public keys at a JWKS endpoint. EdDSA is better-auth's default
# signing algorithm; RS256/ES256 are accepted too in case a project is configured
# differently.
NEON_AUTH_JWT_ALGORITHMS = ["EdDSA", "RS256", "ES256"]


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    # Cached per URL so the JWKS document isn't re-fetched on every request;
    # PyJWKClient also caches the individual signing keys it resolves.
    return jwt.PyJWKClient(jwks_url, cache_keys=True)


def verify_neon_auth_token(
    token: str, *, jwks_url: str, issuer: str | None, audience: str | None,
) -> dict[str, Any]:
    """Cryptographically verifies a Neon Auth session JWT against its JWKS endpoint.

    Raises DomainError(401) for any invalid, unsigned, expired, or wrong-issuer/
    audience token — this must never fall back to trusting an unverified claim.
    """
    try:
        signing_key = _jwks_client(jwks_url).get_signing_key_from_jwt(token)
        # PyJWT only *skips* an unset check symmetrically for `issuer` — pass
        # `audience=None` against a token that actually carries an `aud` claim
        # (Neon Auth's always do) and it raises InvalidAudienceError instead of
        # treating "no expected audience configured" as "don't check". Passing
        # `verify_aud: False` here is PyJWT's documented way to actually opt out,
        # restoring the "only checked once configured" behavior every sign-in
        # otherwise fails with regardless of how valid the token is.
        options: dict[str, Any] = {"require": ["exp", "sub"]}
        if audience is None:
            options["verify_aud"] = False
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=NEON_AUTH_JWT_ALGORITHMS,
            issuer=issuer,
            audience=audience,
            options=options,
        )
    except jwt.PyJWKClientError as exc:
        raise DomainError("Could not verify Neon Auth token signature", 401) from exc
    except jwt.ExpiredSignatureError as exc:
        raise DomainError("Neon Auth token has expired", 401) from exc
    except jwt.InvalidTokenError as exc:
        raise DomainError("Invalid Neon Auth token", 401) from exc
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
