"""Outgoing email via SMTP or the Resend API. Without either, emails are printed to the server console.

Test your settings:  uv run python -m backend.app.mailer you@example.com
"""

import html as _html
import smtplib
import ssl
import sys
import threading
from email.message import EmailMessage

import httpx

from . import config


def provider() -> str:
    if config.RESEND_API_KEY:
        return "resend"
    if config.SMTP_HOST:
        return "smtp"
    return "console"


def email_configured() -> bool:
    return provider() != "console"


def sender() -> str:
    """Resend uses EMAIL_FROM; SMTP uses SMTP_FROM, falling back to the login address."""
    if provider() == "resend":
        return config.EMAIL_FROM
    return config.SMTP_FROM or config.SMTP_USER


def _log(msg: str) -> None:
    print(f"[tek-plane] {msg}", file=sys.stderr, flush=True)


def _hint(exc: Exception) -> str:
    text = str(exc)
    if isinstance(exc, smtplib.SMTPAuthenticationError) or "535" in text or "534" in text:
        return ("SMTP login was rejected. For Gmail you need 2-Step Verification and an App Password "
                "(https://myaccount.google.com/apppasswords), not your normal password.")
    if isinstance(exc, (TimeoutError, ConnectionRefusedError, OSError)) and not isinstance(exc, smtplib.SMTPException):
        return f"Could not reach {config.SMTP_HOST}:{config.SMTP_PORT}. Check SMTP_HOST, SMTP_PORT and SMTP_SECURITY."
    if isinstance(exc, smtplib.SMTPSenderRefused) or "sender" in text.lower():
        return "The server refused the sender address. Set SMTP_FROM/EMAIL_FROM to an address your account may send from."
    return ""


def _send_smtp(to: str, subject: str, text: str, html: str | None) -> None:
    msg = EmailMessage()
    msg["From"] = sender()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    if config.SMTP_SECURITY == "ssl":
        server = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, context=ssl.create_default_context(), timeout=20)
    else:
        server = smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=20)
        if config.SMTP_SECURITY == "starttls":
            server.starttls(context=ssl.create_default_context())
    with server:
        if config.SMTP_USER:
            server.login(config.SMTP_USER, config.SMTP_PASSWORD)
        server.send_message(msg)


def _send_resend(to: str, subject: str, text: str, html: str | None) -> None:
    res = httpx.post("https://api.resend.com/emails", timeout=20,
                     headers={"Authorization": f"Bearer {config.RESEND_API_KEY}"},
                     json={"from": sender(), "to": [to], "subject": subject, "text": text,
                           **({"html": html} if html else {})})
    if res.status_code >= 300:
        raise RuntimeError(f"Resend API {res.status_code}: {res.text[:300]}")


def deliver(to: str, subject: str, text: str, html: str | None = None) -> None:
    """Send now (blocking). Raises on failure."""
    kind = provider()
    if kind == "resend":
        _send_resend(to, subject, text, html)
    elif kind == "smtp":
        _send_smtp(to, subject, text, html)
    else:
        _log(f"Email not configured (see .env.example). Email to {to}:\n  Subject: {subject}\n  {text}\n")


def send_email(to: str, subject: str, text: str, html: str | None = None) -> None:
    """Send in the background so requests stay fast; failures are logged with a hint."""
    if not email_configured():
        deliver(to, subject, text, html)
        return

    def run():
        try:
            deliver(to, subject, text, html)
            _log(f"Email sent to {to}: {subject}")
        except Exception as exc:  # noqa: BLE001 - report everything, the request already returned
            hint = _hint(exc)
            _log(f"Email to {to} FAILED: {exc}" + (f"\n  Hint: {hint}" if hint else ""))

    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- templates

def _layout(title: str, intro: str, body_html: str, footer: str) -> str:
    return f"""<div style="background:#f6f5f2;padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:460px;margin:auto;background:#fff;border-radius:18px;padding:30px 28px;color:#37352f;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <div style="font-weight:700;font-size:15px;color:#2383e2;margin-bottom:18px">tek-plane</div>
    <h2 style="margin:0 0 8px;font-size:22px">{title}</h2>
    <p style="margin:0 0 20px;color:#6b6a66;line-height:1.55">{intro}</p>
    {body_html}
    <p style="margin:22px 0 0;color:#9b9a97;font-size:12.5px;line-height:1.5">{footer}</p>
  </div>
</div>"""


def _button(url: str, label: str) -> str:
    return (f'<a href="{_html.escape(url)}" style="display:inline-block;background:#2383e2;color:#fff;text-decoration:none;'
            f'font-weight:600;padding:12px 22px;border-radius:999px">{_html.escape(label)}</a>')


def send_login_email(to: str, code: str, link: str, is_new: bool) -> None:
    minutes = config.OTP_TTL_MINUTES
    if is_new:
        subject = f"Activate your tek-plane account ({code})"
        title, action = "Activate your account", "Activate account"
        intro = "Welcome! Click the button to activate your account and sign in, or enter the code below."
    else:
        subject = f"{code} is your tek-plane login code"
        title, action = "Sign in to tek-plane", "Sign in"
        intro = "Click the button to sign in, or enter the code below on the sign-in page."
    body = (f'<p style="margin:0 0 22px">{_button(link, action)}</p>'
            f'<div style="font-size:30px;font-weight:700;letter-spacing:8px;background:#f6f5f2;border-radius:12px;'
            f'padding:14px;text-align:center">{code}</div>')
    text = f"{title}\n\n{action}: {link}\n\nOr enter this code: {code}\n\nThe link and code expire in {minutes} minutes."
    send_email(to, subject, text, _layout(title, intro, body,
               f"The link and code expire in {minutes} minutes and work once. If you didn't ask for this, ignore this email."))


def send_invite_email(to: str, inviter: str, project: str, link: str) -> None:
    days = config.INVITE_LINK_TTL_DAYS
    title = f"{_html.escape(inviter)} invited you to “{_html.escape(project)}”"
    text = (f"{inviter} added you to the project “{project}” on tek-plane.\n\nAccept the invitation: {link}\n\n"
            f"The link works once and expires in {days} days. Later you can sign in with Google or an email code.")
    send_email(to, f"{inviter} invited you to “{project}” on tek-plane", text,
               _layout(title, "You've been added to a project on tek-plane. Accept to activate your account and open it.",
                       f'<p style="margin:0">{_button(link, "Accept invitation")}</p>',
                       f"The link works once and expires in {days} days. Afterwards, sign in with Google or an email code."))


# ---------------------------------------------------------------- CLI test

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: uv run python -m backend.app.mailer you@example.com")
        sys.exit(2)
    target = sys.argv[1]
    kind = provider()
    print(f"Provider: {kind}" + (f" ({config.SMTP_HOST}:{config.SMTP_PORT}, {config.SMTP_SECURITY})" if kind == "smtp" else ""))
    print(f"From:     {sender()}")
    if kind == "console":
        print("No email provider configured. Copy .env.example to .env and set RESEND_API_KEY or the SMTP_* values.")
        sys.exit(1)
    try:
        deliver(target, "tek-plane test email", "If you can read this, email delivery works.",
                _layout("It works!", "Email delivery from tek-plane is configured correctly.", "", "Sent by the test command."))
        print(f"Sent to {target}. Check the inbox (and the spam folder).")
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {exc}")
        hint = _hint(exc)
        if hint:
            print(f"Hint: {hint}")
        sys.exit(1)
