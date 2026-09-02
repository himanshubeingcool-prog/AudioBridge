"""QR code generation for the local URL."""
import io
import base64
import logging

logger = logging.getLogger(__name__)

try:
    import qrcode
    from qrcode.image.styledpil import StyledPilImage

    HAS_QR = True
except ImportError:
    HAS_QR = False


def generate_qr_base64(url: str) -> str | None:
    """Generate a QR code PNG as a base64 data URI. Returns None if qrcode not installed."""
    if not HAS_QR:
        return None
    try:
        qr = qrcode.QRCode(version=1, error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=10, border=2)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"
    except Exception as e:
        logger.warning("QR generation failed: %s", e)
        return None


def generate_qr_ascii(url: str) -> str | None:
    """Generate a small ASCII/unicode QR for terminal display."""
    if not HAS_QR:
        return None
    try:
        qr = qrcode.QRCode(version=1, error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=1, border=1)
        qr.add_data(url)
        qr.make(fit=True)
        matrix = qr.modules
        # Render with block characters
        lines: list[str] = []
        for row in matrix:
            line = "".join("\u2588\u2588" if cell else "  " for cell in row)
            lines.append(line)
        return "\n".join(lines)
    except Exception:
        return None
