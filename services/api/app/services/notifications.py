"""Notification senders (TDD §15.3).

Push and email sit behind interfaces so the Expo Push Service can be swapped for direct
APNs/FCM without touching business logic. Every sender must be idempotent: outbox
delivery is at-least-once, so the same notification can legitimately be attempted twice.
"""

import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

import structlog

log = structlog.get_logger()


@dataclass(frozen=True)
class Notification:
    user_id: str
    title: str
    body: str
    #: Deep link so a tap opens the exact booking (FR-10.3).
    link: str | None = None
    email: str | None = None


class Sender(Protocol):
    name: str

    async def send(self, notification: Notification) -> None: ...


class LoggingPushSender:
    """Stands in for Expo Push until device tokens are registered (Phase 1 has no
    push credentials yet). It is a real sender, not a mock: it runs in production
    code paths and its output is the audit trail for what would have been delivered."""

    name = "push"

    async def send(self, notification: Notification) -> None:
        log.info(
            "notification.push",
            user_id=notification.user_id,
            title=notification.title,
            body=notification.body,
            link=notification.link,
        )


class SmtpEmailSender:
    """Delivers to the local mail catcher in development (mailpit, port 1025) and to a
    real relay elsewhere. Synchronous smtplib is acceptable here because it runs in a
    worker, never on a request path."""

    name = "email"

    def __init__(
        self, host: str = "localhost", port: int = 1025, sender: str = "noreply@deskflow.test"
    ):
        self.host, self.port, self.sender = host, port, sender

    async def send(self, notification: Notification) -> None:
        if not notification.email:
            log.warning(
                "notification.email.skipped", reason="no address", user_id=notification.user_id
            )
            return
        message = EmailMessage()
        message["From"] = self.sender
        message["To"] = notification.email
        message["Subject"] = notification.title
        body = notification.body
        if notification.link:
            body += f"\n\n{notification.link}"
        message.set_content(body)
        try:
            with smtplib.SMTP(self.host, self.port, timeout=10) as smtp:
                smtp.send_message(message)
            log.info("notification.email", to=notification.email, title=notification.title)
        except OSError as exc:
            # A dead mail relay must not fail the booking's other side effects; the
            # dispatcher retries the whole event with backoff.
            raise RuntimeError(f"email delivery failed: {exc}") from exc


@dataclass
class Notifier:
    senders: tuple[Sender, ...]

    async def send(self, notification: Notification) -> None:
        for sender in self.senders:
            await sender.send(notification)
