"""Reject recognizable credential material before publishing review comments."""

from __future__ import annotations

import re


class PublicContentError(ValueError):
    """Public comment text contains a recognizable credential pattern."""


_PATTERNS = (
    ("private-key material", re.compile(
        r"-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|"
        r"-----BEGIN PGP PRIVATE KEY BLOCK-----", re.IGNORECASE,
    )),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")),
    ("OpenAI token", re.compile(r"\bsk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})\b")),
    ("Anthropic token", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Stripe secret key", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b")),
    ("bearer credential", re.compile(
        r"\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}", re.IGNORECASE,
    )),
    ("credential-bearing URL", re.compile(r"https?://[^\s/:@]+:[^\s/@]+@[^\s/]+", re.IGNORECASE)),
    ("credential assignment", re.compile(
        r"\b(?:password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)"
        r"\b\s*[:=]\s*(?:[\"'`]([^\"'`\s,;}]{8,})[\"'`]|([A-Za-z0-9_./+=-]{24,}))",
        re.IGNORECASE,
    )),
    ("US Social Security number", re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")),
)

_EMAIL = re.compile(
    r"\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?P<domain>[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?"
    r"(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+)\b", re.IGNORECASE,
)
_RESERVED_EMAIL_DOMAINS = {"example.com", "example.net", "example.org", "localhost", "invalid", "test"}
_CARD_NUMBER = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")


def _is_payment_card(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    parity = len(digits) % 2
    for index, character in enumerate(digits):
        number = int(character)
        if index % 2 == parity:
            number *= 2
            if number > 9:
                number -= 9
        total += number
    return total % 10 == 0


def ensure_public_content(text: object, label: str = "Comment") -> None:
    """Fail closed on known credential forms without echoing matched text.

    This checks common credentials and a few high-confidence personal/payment
    identifiers. It is not a general secret or PII detector. Callers should
    avoid putting sensitive details in review text.
    """
    if not isinstance(text, str):
        raise PublicContentError(f"{label} must be text")
    for name, pattern in _PATTERNS:
        if pattern.search(text):
            raise PublicContentError(
                f"{label} contains recognizable {name}; remove the value before publication"
            )
    for match in _EMAIL.finditer(text):
        domain = match.group("domain").casefold()
        if domain not in _RESERVED_EMAIL_DOMAINS and not domain.endswith((".example", ".invalid", ".test")):
            raise PublicContentError(
                f"{label} contains an email address; remove it before publication"
            )
    if any(_is_payment_card(match.group()) for match in _CARD_NUMBER.finditer(text)):
        raise PublicContentError(
            f"{label} contains a recognizable payment-card number; remove it before publication"
        )
