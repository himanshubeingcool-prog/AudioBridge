"""LAN IP detection and session token generation."""
import socket
import secrets
import logging

logger = logging.getLogger(__name__)


def get_lan_ip() -> str | None:
    """Detect the PC's LAN IPv4 address.

    Tries to connect to a public IP (without actually sending data)
    to determine the local interface that would be used.
    Falls back to hostname resolution.
    """
    # Primary: UDP socket trick - no packets are sent, just routing table lookup
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass

    # Fallback: hostname resolution
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_DGRAM):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass

    return None


def generate_token(length: int = 16) -> str:
    """Generate a random URL-safe session token."""
    return secrets.token_urlsafe(length)[:length]


def generate_pairing_code(length: int = 6) -> str:
    """Generate a short numeric pairing code (e.g. 482913)."""
    return "".join(secrets.choice("0123456789") for _ in range(length))


def code_to_token(code: str) -> str | None:
    """Validate a pairing code format (6 digits). Returns normalized code or None."""
    c = code.strip().replace(" ", "").replace("-", "")
    if len(c) == 6 and c.isdigit():
        return c
    return None


def get_all_lan_ips() -> list[str]:
    """Return all non-loopback IPv4 addresses (for hotspot/Multi-NIC support)."""
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass

    # Also try the UDP trick
    primary = get_lan_ip()
    if primary and primary not in ips:
        ips.insert(0, primary)

    return ips


def get_hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return "PC"


def get_subnet_base(ip: str | None = None) -> str | None:
    """Return subnet base like 192.168.1. for scanning."""
    if ip is None:
        ip = get_lan_ip()
    if not ip:
        return None
    parts = ip.split(".")
    if len(parts) == 4:
        return ".".join(parts[:3]) + "."
    return None
