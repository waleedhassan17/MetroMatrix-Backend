"""Pakistan calendar days (UTC+05:00, no DST since 2009) — how every user counts days."""
from datetime import datetime, timedelta, timezone

PKT = timezone(timedelta(hours=5))


def pkt_today(now=None):
    now = now or datetime.now(timezone.utc)
    return now.astimezone(PKT).date()


def day_range(start, end):
    """Inclusive list of dates."""
    out = []
    d = start
    while d <= end:
        out.append(d)
        d += timedelta(days=1)
    return out
