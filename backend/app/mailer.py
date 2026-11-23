"""Outgoing email. Falls back to printing to the server console when SMTP isn't configured."""

import smtplib
import ssl
import sys
import threading
from email.message import EmailMessage

from . import config


def email_configured() -> bool:
    return bool(config.SMTP_HOST)


def _send_smtp(msg: EmailMessage) -> None:
    try:
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
    except Exception as exc:  # delivery runs in the background; report and move on
        print(f"[tek-plane] Email to {msg['To']} failed: {exc}", file=sys.stderr, flush=True)


def send_email(to: str, subject: str, text: str, html: str | None = None) -> None:
    if not email_configured():
        print(f"\n[tek-plane] SMTP not configured. Email to {to}:\n  Subject: {subject}\n  {text}\n",
              file=sys.stderr, flush=True)
        return
    msg = EmailMessage()
    msg["From"] = config.SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    threading.Thread(target=_send_smtp, args=(msg,), daemon=True).start()


def send_login_code(to: str, code: str) -> None:
    minutes = config.OTP_TTL_MINUTES
    text = f"Your tek-plane login code is {code}\n\nIt expires in {minutes} minutes. If you didn't ask for it, ignore this email."
    html = f"""<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px;color:#1b2333">
  <h2 style="margin:0 0 12px">Your login code</h2>
  <p style="margin:0 0 18px;color:#556074">Enter this code in tek-plane to sign in.</p>
  <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f3f5f9;border-radius:10px;padding:16px;text-align:center">{code}</div>
  <p style="margin:18px 0 0;color:#8a93a5;font-size:13px">It expires in {minutes} minutes. If you didn't ask for it, you can ignore this email.</p>
</div>"""
    send_email(to, f"{code} is your tek-plane login code", text, html)
