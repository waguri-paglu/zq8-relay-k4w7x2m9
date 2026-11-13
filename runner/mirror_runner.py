#!/usr/bin/env python3
"""
On-Demand Gigabit Mirror Runner for GitHub Actions.
- Normal Roboto (native Telegram UI text) for prose, labels, engines, and folder names
- Monospace (<code> / <pre>) for filenames, numeric telemetry, progress bars, and system stats
- Colored InlineKeyboardButtons (style: "primary" | "danger" | "success")

Job item types:
  {"type": "url", "url": "..."}                         -> Aria2c download
  {"type": "gdrive", "id": "...", "resourceKey": "..."} -> Drive server-side copy / clone,
                                                          or authenticated download for extract/zip
"""

import base64
import html
import http.client
import http.server
import importlib
import json
import os
import re
import shutil
import signal
import site
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
JOB_SECRET = os.environ.get("JOB_SECRET", "")
JOB_ID = os.environ.get("JOB_ID", "")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
GITHUB_RUN_ID = os.environ.get("GITHUB_RUN_ID", "")
YTDL_COOKIES = os.environ.get("YTDL_COOKIES", "")

REPO_URL = "https://github.com/waguri-paglu/zq8-relay-k4w7x2m9"

WORK_DIR = Path("/tmp/mirror_work")
DL_DIR = WORK_DIR / "downloads"
OUT_DIR = WORK_DIR / "output"
RCLONE_CONF = Path.home() / ".config" / "rclone" / "rclone.conf"

TICK_SECONDS = 2.5
TOKEN_REFRESH_SECONDS = 40 * 60  # Google access tokens live ~60 min
FOLDER_MIME = "application/vnd.google-apps.folder"
TAR_SUFFIXES = (".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".txz", ".tar")
COMPOUND_SUFFIXES = (".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst")
ARIA_ENGINE = "Aria2c v1.37.0"
GOFILE_NOTICE_HTML = (
    "⚠ <b>Temporary Storage (Gofile):</b> Files are deleted after <b>100 GB download quota</b> "
    "or <b>10 days of inactivity</b>. Re-mirror from the original source to renew, "
    "or /login with your personal Google Drive for permanent storage."
)

cancelled = False


def handle_sig(signum, frame):
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, handle_sig)
signal.signal(signal.SIGINT, handle_sig)


# ============================================================================
# GENERIC HELPERS
# ============================================================================

def mask_secret(val: str, min_len: int = 5):
    if val and len(val) >= min_len:
        print(f"::add-mask::{val}", flush=True)


def http_json(url: str, data: dict = None, headers: dict = None, method: str = None, timeout: int = 15):
    req_headers = {"Content-Type": "application/json", "User-Agent": "MirrorRunner/3.0"}
    if headers:
        req_headers.update(headers)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method or ("POST" if body else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        parsed = {}
        try:
            parsed = json.loads(e.read().decode("utf-8"))
        except Exception:
            pass
        return {"ok": False, "error": str(e), "http_status": e.code, "body": parsed}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def worker_call(path: str, payload: dict):
    return http_json(
        f"{WORKER_URL}{path}",
        data=payload,
        headers={"Authorization": f"Bearer {JOB_SECRET}"},
        timeout=15,
    )


def tg_call(method: str, payload: dict):
    if not BOT_TOKEN:
        return {}
    return http_json(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", data=payload, timeout=10)


def edit_status(chat_id, message_id, text: str, reply_markup: dict = None):
    if not chat_id or not message_id:
        return
    payload = {
        "chat_id": chat_id,
        "message_id": int(message_id),
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    tg_call("editMessageText", payload)


def send_message(chat_id, text: str, reply_markup: dict = None):
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return tg_call("sendMessage", payload)


def fmt_bytes(num: float) -> str:
    if not num or num <= 0:
        return "0.00 B"
    for unit in ["B", "KiB", "MiB", "GiB", "TiB"]:
        if abs(num) < 1024.0:
            return f"{num:.2f} {unit}"
        num /= 1024.0
    return f"{num:.2f} PiB"


def fmt_sys_bytes(num: float) -> str:
    if num <= 0:
        return "0.00B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(num) < 1024.0:
            return f"{num:.2f}{unit}"
        num /= 1024.0
    return f"{num:.2f}PB"


def fmt_duration(seconds) -> str:
    if seconds is None or seconds < 0 or seconds > 86400 * 7:
        return "-"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h{m}m{s}s"
    if m > 0:
        return f"{m}m{s}s"
    return f"{s}s"


def make_bar(pct: float, length: int = 12) -> str:
    pct = max(0.0, min(100.0, pct))
    filled = int(round((pct / 100.0) * length))
    return "■" * filled + "□" * (length - filled)


def truncate(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[: n - 1] + "…"


def path_size(p: Path) -> int:
    try:
        if p.is_file():
            return p.stat().st_size
        total = 0
        for root, _, files in os.walk(p):
            for fn in files:
                try:
                    total += (Path(root) / fn).stat().st_size
                except OSError:
                    pass
        return total
    except OSError:
        return 0


def q_escape(name: str) -> str:
    return name.replace("\\", "\\\\").replace("'", "\\'")


def split_name(name: str, is_dir: bool):
    if is_dir:
        return name, ""
    low = name.lower()
    for suf in COMPOUND_SUFFIXES:
        if low.endswith(suf) and len(name) > len(suf):
            return name[: -len(suf)], name[-len(suf):]
    suffix = Path(name).suffix
    if suffix and len(suffix) <= 10 and len(name) > len(suffix):
        return name[: -len(suffix)], suffix
    return name, ""


def archive_stem(name: str) -> str:
    low = name.lower()
    for suf in TAR_SUFFIXES:
        if low.endswith(suf) and len(name) > len(suf):
            return name[: -len(suf)]
    stem = Path(name).stem
    return stem or "extracted"


def remote_path(folder_id: str) -> str:
    if not folder_id or folder_id == "root":
        return "userdrive:"
    return f"userdrive,root_folder_id={folder_id}:"


def friendly_drive_error(text: str):
    t = (text or "").lower()
    if "storagequotaexceeded" in t or "storage quota" in t or "quota for this drive" in t:
        return "Google Drive storage is full. Free up space and try again."
    if (
        "uploadlimit" in t
        or "upload limit" in t
        or "userratelimitexceeded" in t
        or "user rate limit exceeded" in t
        or "maxuploadedbytes" in t
    ):
        return "Google Drive's daily upload limit (~750 GB / 24h) was reached. Try again later."
    if "downloadquotaexceeded" in t or "download quota" in t or "dailylimitexceeded" in t:
        return "The source file's Drive download quota is exhausted. Try again in ~24h."
    if "cannotcopyfile" in t or "copyrequireswriterpermission" in t or "cannotdownloadfile" in t:
        return "The file owner has disabled copying / downloading for this file."
    if "filenotfound" in t or "notfound" in t or "file not found" in t:
        return "Drive file not found, or it is not shared with your Google account."
    if "insufficientfilepermissions" in t or "insufficientpermissions" in t:
        return "Your Google account has no permission to access this file."
    if "invalid credentials" in t or "unauthenticated" in t or "token expired" in t:
        return "Google Drive authorization failed. Run /login again."
    return None


def drive_error_text(res: dict, fallback: str) -> str:
    body = res.get("body") or {}
    err = body.get("error") or {}
    reasons = " ".join(str(e.get("reason", "")) for e in (err.get("errors") or []))
    message = str(err.get("message") or res.get("error") or "")
    return friendly_drive_error(f"{reasons} {message}") or (f"{fallback}: {message}" if message else fallback)


class SystemMonitor:
    def __init__(self):
        self.start_time = time.time()
        self.prev_cpu = self._read_cpu()
        self.prev_net = self._read_net()
        self.prev_time = time.time()
        self.base_rx, self.base_tx = self.prev_net

    def _read_cpu(self):
        try:
            with open("/proc/stat", "r") as f:
                parts = [int(x) for x in f.readline().split()[1:]]
            idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
            return idle, sum(parts)
        except Exception:
            return 0, 1

    def _read_net(self):
        rx, tx = 0, 0
        try:
            with open("/proc/net/dev", "r") as f:
                for line in f.readlines()[2:]:
                    if ":" not in line:
                        continue
                    iface, data = line.split(":", 1)
                    if iface.strip() == "lo":
                        continue
                    fields = data.split()
                    rx += int(fields[0])
                    tx += int(fields[8])
        except Exception:
            pass
        return rx, tx

    def snapshot(self):
        now = time.time()
        dt = max(0.5, now - self.prev_time)

        idle1, total1 = self.prev_cpu
        idle2, total2 = self._read_cpu()
        self.prev_cpu = (idle2, total2)
        d_total = max(1, total2 - total1)
        cpu_pct = max(0.0, min(100.0, 100.0 * (1.0 - (idle2 - idle1) / d_total)))

        ram_pct = 0.0
        try:
            mem = {}
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    k, v = line.split(":", 1)
                    mem[k.strip()] = int(v.strip().split()[0])
            total_mem = mem.get("MemTotal", 1)
            avail_mem = mem.get("MemAvailable", total_mem)
            ram_pct = 100.0 * (total_mem - avail_mem) / total_mem
        except Exception:
            pass

        du = shutil.disk_usage("/")
        rx2, tx2 = self._read_net()
        rx_spd = max(0.0, (rx2 - self.prev_net[0]) / dt)
        tx_spd = max(0.0, (tx2 - self.prev_net[1]) / dt)
        self.prev_net = (rx2, tx2)
        self.prev_time = now

        return {
            "cpu_pct": cpu_pct,
            "ram_pct": ram_pct,
            "free_gb": du.free / (1024 ** 3),
            "disk_pct": 100.0 * du.used / max(1, du.total),
            "rx_spd": fmt_sys_bytes(rx_spd) + "/s",
            "tx_spd": fmt_sys_bytes(tx_spd) + "/s",
            "rx_tot": fmt_sys_bytes(max(0, rx2 - self.base_rx)),
            "tx_tot": fmt_sys_bytes(max(0, tx2 - self.base_tx)),
            "uptime": fmt_duration(now - self.start_time),
        }


def dot_for(pct: float) -> str:
    if pct >= 85:
        return "🔴"
    if pct >= 60:
        return "🟠"
    return "🟢"


def build_status_card(
    job: dict,
    filename: str,
    status_text: str,
    pct: float,
    done_bytes: float,
    total_bytes: float,
    speed_bps: float,
    eta_sec,
    engine: str,
    elapsed_sec: float,
    sys_snap: dict,
    batch_pos=None,
) -> str:
    mode_map = {"normal": "Mirror", "extract": "Extract", "zip": "ArchiveZIP"}
    if job.get("isYtdl"):
        q = job.get("ytQuality", "best")
        mode_str = "Audio" if q in ("mp3", "m4a", "opus", "flac") else "yt-dlp"
    else:
        mode_str = mode_map.get(job.get("mode", "normal"), "Mirror")
    uname = job.get("username") or "User"
    if not uname.startswith("@") and uname != "User":
        uname = "@" + uname
    uid = job.get("userId", "")
    short_id = job.get("jobId", "")

    bar = make_bar(pct, 12)
    cpu_bar = make_bar(sys_snap["cpu_pct"], 10)
    ram_bar = make_bar(sys_snap["ram_pct"], 10)
    disk_bar = make_bar(sys_snap["disk_pct"], 10)

    total_str = fmt_bytes(total_bytes) if total_bytes and total_bytes > 0 else "Unknown"
    run_url = f"{REPO_URL}/actions/runs/{GITHUB_RUN_ID}" if GITHUB_RUN_ID else f"{REPO_URL}/actions"

    sys_block = (
        f"┌ SYSTEM\n"
        f"├ {dot_for(sys_snap['cpu_pct'])} Cpu [{cpu_bar}] {sys_snap['cpu_pct']:.1f}%\n"
        f"├ {dot_for(sys_snap['ram_pct'])} Ram [{ram_bar}] {sys_snap['ram_pct']:.1f}%\n"
        f"├ {dot_for(sys_snap['disk_pct'])} Free [{disk_bar}] {sys_snap['free_gb']:.2f}GB\n"
        f"├ ⚡ Spd ↓ {sys_snap['rx_spd']} ↑ {sys_snap['tx_spd']}\n"
        f"├ 🌐 Net ↓ {sys_snap['rx_tot']} ↑ {sys_snap['tx_tot']}\n"
        f"└ 🕒 Upt {sys_snap['uptime']}"
    )

    lines = [
        f"<blockquote>📄 <b>Name :</b> <code>{html.escape(filename)}</code></blockquote>",
        "",
        f"┌ Status : <a href=\"{run_url}\">{html.escape(status_text)}</a> ({pct:.2f}%)",
        f"├ [<code>{bar}</code>]",
    ]
    if batch_pos:
        lines.append(f"├ Batch : <code>{batch_pos[0]} / {batch_pos[1]}</code>")
    lines += [
        f"├ By : {html.escape(uname)}",
        f"├ UserID : <code>[{html.escape(str(uid))}]</code>",
        f"├ Elapsed : <code>{fmt_duration(elapsed_sec)}</code>",
        f"├ Size : <code>{total_str}</code>",
        f"├ Processed : <code>{fmt_bytes(done_bytes)}</code>",
        f"├ ETA : <code>{fmt_duration(eta_sec)}</code>",
        f"├ Speed : <code>{fmt_bytes(speed_bps)}/s</code>",
        f"├ Engine : <code>{html.escape(engine)}</code>",
        f"├ Mode : <code>#{mode_str}</code>",
        f"└ ⛔ /cancel_{html.escape(short_id)}",
        "",
        "____________________________",
        "",
        f"<pre><code>{html.escape(sys_block)}</code></pre>",
    ]
    return "\n".join(lines)


def status_keyboard(job_id: str) -> dict:
    return {
        "inline_keyboard": [
            [
                {"text": "🔄 Refresh", "callback_data": f"st_ref:{job_id}", "style": "primary"},
                {"text": "🔽 Close", "callback_data": f"st_close:{job_id}", "style": "danger"},
            ]
        ]
    }


def aria2_rpc(method: str, params: list = None):
    payload = {"jsonrpc": "2.0", "id": "1", "method": method, "params": params or []}
    return http_json("http://127.0.0.1:6800/jsonrpc", data=payload, timeout=5)


def sync_worker_state(job_id: str, last_card: str = None):
    payload = {"job_id": job_id}
    if last_card:
        payload["last_card"] = last_card
    res = worker_call("/internal/job-status", payload)
    is_cancelled = bool(res.get("cancelled"))
    msg_id = str(res.get("messageId") or "") if "messageId" in res else None
    return is_cancelled, msg_id


def finish_status(chat_id, message_id, text: str, reply_markup: dict = None):
    if message_id:
        edit_status(chat_id, message_id, text, reply_markup)
    elif chat_id:
        send_message(chat_id, text, reply_markup)


# ============================================================================
# LINK RESOLVER & SHORTENER UNWRAPPER
# ============================================================================

DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
DIRECT_EXT_RE = re.compile(
    r"\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|tar\.xz|txz|mkv|mp4|avi|webm|mov|m4v|mp3|flac|m4a|ogg|wav|iso|img|apk|exe|msi|dmg|deb|rpm|appimage|pdf|epub|bin)(\?.*)?$",
    re.I,
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIR_OPENER = urllib.request.build_opener(_NoRedirect())


def parse_drive_url(raw_url: str):
    try:
        u = urllib.parse.urlparse(raw_url)
        host = (u.hostname or "").lower()
        if not (host.endswith("drive.google.com") or host.endswith("docs.google.com") or host == "drive.usercontent.google.com"):
            return None
        qs = urllib.parse.parse_qs(u.query)
        rk = (qs.get("resourcekey") or qs.get("resourceKey") or [""])[0]
        m_folder = re.search(r"/folders/([a-zA-Z0-9_-]{10,})", u.path)
        if m_folder:
            return {"type": "gdrive", "id": m_folder.group(1), "resourceKey": rk}
        m_file = re.search(r"/d/([a-zA-Z0-9_-]{10,})", u.path)
        if m_file:
            return {"type": "gdrive", "id": m_file.group(1), "resourceKey": rk}
        id_param = (qs.get("id") or [""])[0]
        if id_param and re.match(r"^[a-zA-Z0-9_-]{10,}$", id_param):
            return {"type": "gdrive", "id": id_param, "resourceKey": rk}
    except Exception:
        pass
    return None


def rewrite_known_direct_url(raw_url: str):
    try:
        u = urllib.parse.urlparse(raw_url)
        host = (u.hostname or "").lower().removeprefix("www.")
        if host == "pixeldrain.com":
            m_f = re.match(r"^/u/([a-zA-Z0-9_-]+)", u.path)
            if m_f:
                return f"https://pixeldrain.com/api/file/{m_f.group(1)}?download"
            m_l = re.match(r"^/l/([a-zA-Z0-9_-]+)", u.path)
            if m_l:
                return f"https://pixeldrain.com/api/list/{m_l.group(1)}/zip"
        if host == "dropbox.com":
            qs = urllib.parse.parse_qs(u.query, keep_blank_values=True)
            if qs.get("dl") != ["1"]:
                qs["dl"] = ["1"]
                new_q = urllib.parse.urlencode(qs, doseq=True)
                return urllib.parse.urlunparse(u._replace(query=new_q))
        if host == "github.com":
            m = re.match(r"^/([^/]+)/([^/]+)/(?:blob|raw)/(.+)$", u.path)
            if m:
                return f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}"
        if host == "gitlab.com" and "/-/blob/" in u.path:
            return urllib.parse.urlunparse(u._replace(path=u.path.replace("/-/blob/", "/-/raw/", 1)))
        if host == "huggingface.co" and "/blob/" in u.path:
            return urllib.parse.urlunparse(u._replace(path=u.path.replace("/blob/", "/resolve/", 1)))
        if host == "sourceforge.net":
            if re.match(r"^/projects/[^/]+/files/.+$", u.path) and not u.path.endswith("/download") and not u.path.endswith("/"):
                return urllib.parse.urlunparse(u._replace(path=u.path + "/download"))
    except Exception:
        pass
    return None


def detect_challenge_page(headers, body: str):
    if headers and str(headers.get("cf-mitigated", "")).lower() == "challenge":
        return "Protected by anti-bot verification. Open in your browser and send the direct file link."
    low = (body or "")[:60000].lower()
    markers = (
        "cf-turnstile", "challenges.cloudflare.com", "cdn-cgi/challenge-platform",
        "<title>just a moment...</title>", "g-recaptcha", "www.google.com/recaptcha",
        "h-captcha", "hcaptcha.com/1/api.js",
    )
    if any(m in low for m in markers):
        return "Protected by CAPTCHA or anti-bot verification. Open in your browser and send the direct file link."
    return None


def _extract_attr(tag: str, name: str) -> str:
    m = re.search(rf'\b{name}\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', tag, re.I)
    if not m:
        return ""
    val = next((g for g in m.groups() if g is not None), "")
    return html.unescape(val.strip())


def _probe_single(url: str, method: str = "HEAD", follow: bool = False):
    headers = {"User-Agent": DEFAULT_UA}
    if method == "GET":
        headers["Range"] = "bytes=0-0"
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        if follow:
            with urllib.request.urlopen(req, timeout=12) as resp:
                return resp.status, dict(resp.headers), resp.geturl()
        with _NO_REDIR_OPENER.open(req, timeout=12) as resp:
            return resp.status, dict(resp.headers), resp.geturl()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.geturl()


def _is_direct_stream(url: str) -> bool:
    try:
        status, hdrs, _ = _probe_single(url, "HEAD", follow=True)
        if status in (403, 405, 501) or status >= 400:
            status, hdrs, _ = _probe_single(url, "GET", follow=True)
        if status >= 400:
            return False
        low = {k.lower(): v for k, v in hdrs.items()}
        ct = low.get("content-type", "").lower()
        cd = low.get("content-disposition", "").lower()
        return ("text/html" not in ct) or ("attachment" in cd)
    except Exception:
        return False


def _extract_host_candidates(page_url: str, body: str) -> list:
    u = urllib.parse.urlparse(page_url)
    host = (u.hostname or "").lower().removeprefix("www.")
    if host == "mediafire.com" or host.endswith(".mediafire.com"):
        if u.path.startswith("/folder/"):
            raise RuntimeError("MediaFire folders are not supported as a single direct link.")
        cands = []
        m = re.search(r'<a\b[^>]*\bid=["\']downloadButton["\'][^>]*>', body, re.I)
        if m:
            href = _extract_attr(m.group(0), "href")
            if href.startswith(("http://", "https://")):
                cands.append(href)
            scram = _extract_attr(m.group(0), "data-scrambled-url")
            if scram:
                try:
                    dec = base64.b64decode(scram).decode("utf-8", "ignore")
                    if dec.startswith(("http://", "https://")):
                        cands.append(dec)
                except Exception:
                    pass
        if cands:
            return cands

    if host == "sourceforge.net":
        cands = []
        for pat in (r'data-release-url=["\'](https?://[^"\']+)["\']', r'href=["\'](https?://downloads\.sourceforge\.net/[^"\']+)["\']'):
            m = re.search(pat, body, re.I)
            if m:
                cands.append(html.unescape(m.group(1)))
        if cands:
            return cands

    if host == "onedrive.live.com" or host.endswith(".sharepoint.com"):
        b64 = base64.b64encode(page_url.encode("utf-8")).decode("ascii").rstrip("=").replace("+", "-").replace("/", "_")
        return [f"https://api.onedrive.com/v1.0/shares/u!{b64}/root/content"]

    scored = []
    seen = set()
    for m in re.finditer(r"<a\b([^>]{1,600})>", body, re.I):
        attrs = m.group(1)
        href = _extract_attr(attrs, "href")
        if not href or href.startswith("#") or href.lower().startswith(("javascript:", "mailto:", "tel:")):
            continue
        abs_url = urllib.parse.urljoin(page_url, href)
        if not abs_url.startswith(("http://", "https://")) or abs_url == page_url or abs_url in seen:
            continue
        seen.add(abs_url)
        id_cls = (_extract_attr(attrs, "id") + " " + _extract_attr(attrs, "class")).lower()
        score = 0
        if re.search(r"\bdownload\b", attrs, re.I):
            score += 5
        if re.search(r"(?:^|[\s_-])(download|dl-btn|dl_btn|download-btn|btn-download)(?:$|[\s_-])", id_cls):
            score += 4
        if DIRECT_EXT_RE.search(abs_url):
            score += 3
        if score >= 3:
            scored.append((score, abs_url))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [u for _, u in scored[:3]]


def resolve_download_url(raw_url: str) -> dict:
    cur = raw_url
    visited = set()
    for _ in range(10):
        gd = parse_drive_url(cur)
        if gd:
            return gd

        rewritten = rewrite_known_direct_url(cur)
        if rewritten and rewritten != cur and rewritten not in visited:
            visited.add(cur)
            cur = rewritten
            continue

        if cur in visited:
            break
        visited.add(cur)

        status, hdrs, _ = _probe_single(cur, "HEAD")
        low = {k.lower(): v for k, v in hdrs.items()}
        if 300 <= status < 400 and low.get("location"):
            cur = urllib.parse.urljoin(cur, low["location"])
            continue

        if status in (403, 405, 501) or status >= 400:
            status, hdrs, _ = _probe_single(cur, "GET")
            low = {k.lower(): v for k, v in hdrs.items()}
            if 300 <= status < 400 and low.get("location"):
                cur = urllib.parse.urljoin(cur, low["location"])
                continue

        ct = low.get("content-type", "").lower()
        cd = low.get("content-disposition", "").lower()
        if "text/html" not in ct or "attachment" in cd:
            if status >= 400:
                raise RuntimeError(f"Remote server returned HTTP {status}.")
            return {"type": "url", "url": cur}

        req = urllib.request.Request(cur, headers={"User-Agent": DEFAULT_UA, "Accept": "text/html,application/xhtml+xml"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            final_url = resp.geturl() or cur
            if final_url != cur:
                gd2 = parse_drive_url(final_url)
                if gd2:
                    return gd2
                cur = final_url
            body = resp.read(262144).decode("utf-8", "ignore")
            blocked = detect_challenge_page(resp.headers, body)
            if blocked:
                raise RuntimeError(blocked)

        for cand in _extract_host_candidates(cur, body):
            if _is_direct_stream(cand):
                return {"type": "url", "url": cand}

        m_meta = re.search(r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]+content=["\'][^"\']*url\s*=\s*([^"\'\s>]+)', body[:60000], re.I)
        if m_meta:
            redir = urllib.parse.urljoin(cur, html.unescape(m_meta.group(1).strip()))
            if redir.startswith(("http://", "https://")) and redir not in visited:
                cur = redir
                continue

        m_js = re.search(r'(?:window\.location(?:\.href)?\s*=\s*|location\.replace\(\s*)["\'](https?://[^"\']+)["\']', body[:60000], re.I)
        if m_js:
            redir = html.unescape(m_js.group(1).strip())
            if redir not in visited:
                cur = redir
                continue

        raise RuntimeError("URL points to an HTML webpage with no extractable direct file link.")
    raise RuntimeError("Too many redirects while resolving link.")


# ============================================================================
# YT-DLP MEDIA ENGINE HELPERS
# ============================================================================

YT_AUDIO_QUALITIES = {"mp3", "m4a", "opus", "flac"}
YT_MEDIA_DOMAINS = (
    "youtube.com", "youtu.be", "music.youtube.com", "instagram.com",
    "tiktok.com", "twitter.com", "x.com", "reddit.com", "v.redd.it",
    "twitch.tv", "vimeo.com", "dailymotion.com", "soundcloud.com",
    "facebook.com", "fb.watch", "bilibili.com", "rumble.com",
    "odysee.com", "kick.com", "streamable.com",
)


def is_media_site_url(raw_url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(raw_url).hostname or "").lower().removeprefix("www.")
        return any(host == d or host.endswith("." + d) for d in YT_MEDIA_DOMAINS)
    except Exception:
        return False


def parse_timestamp_seconds(val: str) -> float:
    parts = [float(p) for p in val.strip().split(":")]
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    raise ValueError("Invalid timestamp")


def parse_trim_range(spec: str):
    if not spec or "-" not in spec:
        return None
    s_raw, e_raw = spec.split("-", 1)
    start = parse_timestamp_seconds(s_raw)
    end = parse_timestamp_seconds(e_raw)
    if end <= start:
        raise RuntimeError(f"Invalid trim range '{spec}': end time must be after start time.")
    return start, end


def _kill_child_procs():
    """Terminate direct child processes (e.g., aria2c/ffmpeg) on cancellation."""
    pid = str(os.getpid())
    try:
        subprocess.run(["pkill", "-TERM", "-P", pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def _ytdir_written_bytes(yt_dir: Path) -> int:
    total = 0
    try:
        for p in yt_dir.iterdir():
            if not p.is_file() or p.name.endswith((".aria2", ".ytdl", ".jpg", ".jpeg", ".png", ".webp")):
                continue
            st = p.stat()
            if st.st_blocks > 0:
                total += min(st.st_size, st.st_blocks * 512)
            else:
                total += st.st_size
    except OSError:
        pass
    return total


def _is_youtube_url(url: str) -> bool:
    """Return True when the target URL belongs to YouTube."""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower().rstrip(".")
    except Exception:
        return False
    return host in ("youtu.be", "youtube.com", "youtube-nocookie.com") or host.endswith((".youtube.com", ".youtube-nocookie.com"))


def ytdl_format_spec(quality: str, container: str) -> str:
    if quality in YT_AUDIO_QUALITIES:
        return "ba/b"
    if quality in ("2160", "1440", "1080", "720", "480", "360"):
        if container == "mp4":
            return f"bv*[height<={quality}][ext=mp4]+ba[ext=m4a]/bv*[height<={quality}]+ba/b[height<={quality}]/b"
        return f"bv*[height<={quality}]+ba/b[height<={quality}]/b"
    if container == "mp4":
        return "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b"
    return "bv*+ba/b"


def friendly_ytdl_error(msg: str) -> str:
    low = (msg or "").lower()
    if "age" in low and ("confirm" in low or "restrict" in low or "sign in" in low):
        return "This video is age-restricted and requires valid YTDL_COOKIES."
    if "sign in to confirm" in low or "not a bot" in low or "cookies" in low or "login required" in low:
        if (YTDL_COOKIES or "").strip():
            return "Cookies rejected or expired — refresh the YTDL_COOKIES GitHub secret."
        return "Site requested anti-bot verification or sign-in cookies (add YTDL_COOKIES GitHub secret)."
    if "private video" in low:
        return "This video is private."
    if "video unavailable" in low or "unavailable" in low:
        return "This video is unavailable or was removed."
    if "geo" in low and "restrict" in low:
        return "This video is geo-restricted in the runner region."
    return msg


def _json_cookies_to_netscape(items: list) -> str:
    lines = ["# Netscape HTTP Cookie File"]
    for c in items:
        if not isinstance(c, dict) or not c.get("domain") or not c.get("name"):
            continue
        domain = str(c["domain"])
        inc_sub = "TRUE" if domain.startswith(".") else "FALSE"
        path = str(c.get("path") or "/")
        secure = "TRUE" if c.get("secure") else "FALSE"
        exp_raw = c.get("expirationDate") or c.get("expiry") or 0
        try:
            exp = str(int(float(exp_raw))) if exp_raw else "0"
        except (TypeError, ValueError):
            exp = "0"
        val = str(c.get("value") or "")
        lines.append("\t".join([domain, inc_sub, path, secure, exp, str(c["name"]), val]))
    return "\n".join(lines) + "\n"


def prepare_ytdl_cookiefile(raw_cookies: str = None):
    raw = (YTDL_COOKIES if raw_cookies is None else raw_cookies) or ""
    text = raw.strip()
    if not text:
        return None

    # Allow single-line base64-encoded cookies.txt so mobile copy/paste never strips tabs/newlines
    if "\n" not in text and "\t" not in text and not text.startswith("[") and not text.startswith("#"):
        try:
            decoded = base64.b64decode(text, validate=True).decode("utf-8", "ignore").strip()
            if "\t" in decoded or decoded.startswith("#") or decoded.startswith("["):
                text = decoded
        except Exception:
            pass

    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                text = _json_cookies_to_netscape(parsed)
        except Exception:
            pass

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.lstrip().startswith("#"):
        text = "# Netscape HTTP Cookie File\n" + text
    if not text.endswith("\n"):
        text += "\n"

    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            mask_secret(s, min_len=8)

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    cookie_path = WORK_DIR / f"ytdl_cookies_{JOB_ID or 'run'}.txt"
    cookie_path.write_text(text, encoding="utf-8")
    os.chmod(cookie_path, 0o600)
    return cookie_path


def ensure_ytdl_tools():
    target_dir = Path("/tmp/ytdl_pkgs")
    if str(target_dir) not in sys.path:
        sys.path.insert(0, str(target_dir))
    user_site = site.getusersitepackages()
    if user_site and os.path.isdir(user_site):
        site.addsitedir(user_site)
    importlib.invalidate_caches()

    try:
        import yt_dlp  # noqa: F401
        import mutagen  # noqa: F401
    except ImportError:
        target_dir.mkdir(parents=True, exist_ok=True)
        pkgs = ["yt-dlp[default]", "mutagen"]
        res = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--break-system-packages", "--upgrade", "-q", "--target", str(target_dir), *pkgs],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        if res.returncode != 0:
            res = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--upgrade", "-q", "--target", str(target_dir), *pkgs],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            if res.returncode != 0:
                raise RuntimeError(f"Failed to install yt-dlp: {(res.stdout or '').strip()[-400:]}")
        if user_site and os.path.isdir(user_site):
            site.addsitedir(user_site)
        importlib.invalidate_caches()
        import yt_dlp  # noqa: F401
    if not shutil.which("ffmpeg"):
        subprocess.run(["sudo", "apt-get", "update", "-qq"], check=False)
        subprocess.run(["sudo", "apt-get", "install", "-y", "-qq", "ffmpeg"], check=True)


# ============================================================================
# MIRROR ENGINE
# ============================================================================

class Mirror:
    def __init__(self, job: dict, access_token: str, token_expiry_ms=None):
        self.job = job
        self.chat_id = job["chatId"]
        self.message_id = job.get("messageId")
        self.dest = job.get("dest") or "gdrive"
        self.folder_id = job.get("folderId") or "root"
        self.folder_name = "Gofile (Guest)" if self.dest == "gofile" else (job.get("folderName") or "My Drive")
        self.custom_name = (job.get("customName") or "").strip()
        self.mode = job.get("mode") or "normal"
        self.select_filter = (job.get("selectFilter") or "").strip()
        self.password = job.get("archivePassword") or ""
        self.share = bool(job.get("share"))
        conflict = job.get("conflict") or "rename"
        self.conflict = conflict if conflict in ("rename", "overwrite", "skip") else "rename"

        self.gofile_token = ""
        self.gofile_root_id = ""
        self.gofile_link = ""
        self.gofile_folders = {}

        items = job.get("items") or []
        if not items and job.get("fileUrl"):
            items = [{"type": "url", "url": job["fileUrl"]}]
        self.items = items
        self.batch = bool(job.get("batch")) or len(items) > 1

        self.access_token = access_token
        self.token_expiry_ms = token_expiry_ms
        self.token_time = time.time()

        self.sys_mon = SystemMonitor()
        self.task_start = time.time()
        self.last_tick = 0.0
        self.last_sync = 0.0
        self.last_card_sync = 0.0
        self.last_sync_status = ""
        self.idx = 0
        self.aria_proc = None
        self.token_srv = None
        self.token_port = 0
        self.token_lock = threading.Lock()

        for it in self.items:
            mask_secret(it.get("url", ""))
        mask_secret(self.password, min_len=3)

    # ---------------- Google token handling ----------------

    def start_token_server(self):
        mirror_ref = self

        class TokenHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                ok = mirror_ref.refresh_token(force=True)
                if not ok:
                    self.send_response(500)
                    self.end_headers()
                    return
                exp_in = 3300
                if mirror_ref.token_expiry_ms:
                    exp_in = max(300, int((float(mirror_ref.token_expiry_ms) - time.time() * 1000) / 1000))
                payload = json.dumps({
                    "access_token": mirror_ref.access_token,
                    "token_type": "Bearer",
                    "expires_in": exp_in,
                    "refresh_token": "worker-managed",
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.token_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), TokenHandler)
        self.token_port = self.token_srv.server_address[1]
        threading.Thread(target=self.token_srv.serve_forever, daemon=True).start()

    def stop_token_server(self):
        if self.token_srv:
            try:
                self.token_srv.shutdown()
                self.token_srv.server_close()
            except Exception:
                pass
            self.token_srv = None

    def write_rclone_conf(self):
        RCLONE_CONF.parent.mkdir(parents=True, exist_ok=True)
        if self.token_expiry_ms:
            exp_dt = datetime.fromtimestamp(float(self.token_expiry_ms) / 1000.0, tz=timezone.utc)
        else:
            exp_dt = datetime.fromtimestamp(time.time() + 45 * 60, tz=timezone.utc)
        token_json = json.dumps({
            "access_token": self.access_token,
            "token_type": "Bearer",
            "refresh_token": "worker-managed",
            "expiry": exp_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        token_url_line = f"token_url = http://127.0.0.1:{self.token_port}/token\n" if self.token_port else ""
        conf_text = (
            "[userdrive]\n"
            "type = drive\n"
            "scope = drive\n"
            "client_id = worker\n"
            "client_secret = worker\n"
            f"{token_url_line}"
            f"token = {token_json}\n"
        )
        tmp = RCLONE_CONF.with_suffix(".tmp")
        tmp.write_text(conf_text, encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, RCLONE_CONF)

    def refresh_token(self, force: bool = True) -> bool:
        with self.token_lock:
            res = worker_call("/internal/refresh", {"job_id": JOB_ID, "force": force})
            if res.get("ok") and res.get("accessToken"):
                self.access_token = res["accessToken"]
                self.token_expiry_ms = res.get("expiry") or None
                self.token_time = time.time()
                mask_secret(self.access_token)
                self.write_rclone_conf()
                return True
            return False

    def ensure_token(self, max_age: float = TOKEN_REFRESH_SECONDS):
        if time.time() - self.token_time >= max_age:
            self.refresh_token(force=True)

    # ---------------- Drive API ----------------

    def drive(self, method: str, path: str, params: dict = None, body: dict = None, resource_key: str = None, timeout: int = 60):
        p = {"supportsAllDrives": "true"}
        if params:
            p.update(params)
        url = f"https://www.googleapis.com/drive/v3/{path}?{urllib.parse.urlencode(p)}"
        for attempt in range(2):
            headers = {"Authorization": f"Bearer {self.access_token}"}
            if resource_key:
                file_id = path.split("/")[1] if path.startswith("files/") else ""
                headers["X-Goog-Drive-Resource-Keys"] = f"{file_id}/{resource_key}"
            res = http_json(url, data=body, headers=headers, method=method, timeout=timeout)
            if res.get("http_status") == 401 and attempt == 0 and self.refresh_token(force=True):
                continue
            return res
        return {}

    def find_existing(self, parent: str, name: str) -> list:
        q = f"'{parent or 'root'}' in parents and name = '{q_escape(name)}' and trashed = false"
        res = self.drive("GET", "files", {
            "q": q,
            "fields": "files(id,name,mimeType,webViewLink,size)",
            "pageSize": "10",
            "orderBy": "modifiedTime desc",
            "includeItemsFromAllDrives": "true",
        })
        return res.get("files") or []

    def free_name(self, parent: str, name: str, is_dir: bool) -> str:
        base, ext = split_name(name, is_dir)
        for n in range(1, 100):
            cand = f"{base} ({n}){ext}"
            if not self.find_existing(parent, cand):
                return cand
        return f"{base} ({int(time.time())}){ext}"

    def resolve_conflict(self, parent: str, name: str, is_dir: bool):
        """Returns (action, final_name, existing_file). action: new | overwrite | skip"""
        existing = self.find_existing(parent, name)
        if not existing:
            return "new", name, None
        ex = existing[0]
        if self.conflict == "skip":
            return "skip", name, ex
        if self.conflict == "overwrite":
            return "overwrite", name, ex
        return "new", self.free_name(parent, name, is_dir), None

    def create_folder(self, parent: str, name: str) -> str:
        res = self.drive("POST", "files", {"fields": "id"}, body={
            "name": name,
            "mimeType": FOLDER_MIME,
            "parents": [parent or "root"],
        })
        if not res.get("id"):
            raise RuntimeError(drive_error_text(res, "Could not create Drive folder"))
        return res["id"]

    def make_public(self, file_id: str) -> bool:
        res = self.drive("POST", f"files/{file_id}/permissions", {"fields": "id"}, body={"role": "reader", "type": "anyone"})
        return bool(res.get("id"))

    def lookup(self, parent: str, name: str):
        found = self.find_existing(parent, name)
        return found[0] if found else None

    def folder_url(self) -> str:
        if self.folder_id and self.folder_id != "root":
            return f"https://drive.google.com/drive/folders/{self.folder_id}"
        return "https://drive.google.com/drive/my-drive"

    def finalize(self, f, name: str, size: float, is_dir: bool, status: str = "completed") -> dict:
        link = self.folder_url()
        fid = ""
        if f:
            fid = f.get("id", "")
            is_dir = is_dir or f.get("mimeType") == FOLDER_MIME
            if is_dir and fid:
                link = f"https://drive.google.com/drive/folders/{fid}"
            elif f.get("webViewLink"):
                link = f["webViewLink"]
            elif fid:
                link = f"https://drive.google.com/file/d/{fid}/view"
        shared = False
        direct = ""
        if fid and self.share and status == "completed":
            shared = self.make_public(fid)
            if shared and not is_dir:
                direct = f"https://drive.google.com/uc?id={fid}&export=download"
        return {
            "name": name,
            "link": link,
            "id": fid,
            "size": size or 0,
            "status": status,
            "isDir": is_dir,
            "shared": shared,
            "direct": direct,
        }

    # ---------------- Telemetry ----------------

    def tick(self, filename, status_text, pct, done, total, speed, eta, engine, force=False):
        global cancelled
        if cancelled:
            raise InterruptedError("Cancelled by user")
        now = time.time()
        if not force and now - self.last_tick < TICK_SECONDS:
            return
        self.last_tick = now
        if self.access_token:
            self.ensure_token()

        card = build_status_card(
            job=self.job,
            filename=filename,
            status_text=status_text,
            pct=pct,
            done_bytes=done,
            total_bytes=total,
            speed_bps=speed,
            eta_sec=eta,
            engine=engine,
            elapsed_sec=now - self.task_start,
            sys_snap=self.sys_mon.snapshot(),
            batch_pos=(self.idx + 1, len(self.items)) if self.batch else None,
        )
        status_changed = (status_text != self.last_sync_status)
        need_card = force or status_changed or (now - self.last_card_sync >= 20.0)
        if need_card or (now - self.last_sync >= 5.0):
            self.last_sync = now
            self.last_sync_status = status_text
            if need_card:
                self.last_card_sync = now
            is_cancelled, synced_msg_id = sync_worker_state(JOB_ID, last_card=card if need_card else None)
            if synced_msg_id is not None:
                self.message_id = synced_msg_id
            if is_cancelled:
                cancelled = True
                raise InterruptedError("Cancelled by user")
        if self.message_id:
            edit_status(self.chat_id, self.message_id, card, status_keyboard(JOB_ID))

    # ---------------- Aria2c ----------------

    def start_aria(self):
        self.aria_proc = subprocess.Popen(
            [
                "aria2c",
                "--enable-rpc=true",
                "--rpc-listen-all=false",
                "--rpc-listen-port=6800",
                "--max-connection-per-server=16",
                "--split=16",
                "--min-split-size=1M",
                "--file-allocation=none",
                "--continue=true",
                "--allow-overwrite=true",
                "--auto-file-renaming=false",
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                f"--dir={DL_DIR}",
                "--quiet=true",
            ],
            stdin=subprocess.DEVNULL,
        )
        time.sleep(1.0)

    def stop_aria(self):
        if self.aria_proc:
            try:
                self.aria_proc.terminate()
            except Exception:
                pass

    def aria_download(self, url: str, dest_dir: Path, out_name: str = None, headers: list = None, label: str = None) -> Path:
        if not self.aria_proc:
            self.start_aria()
        dest_dir.mkdir(parents=True, exist_ok=True)
        opts = {"dir": str(dest_dir)}
        if out_name:
            opts["out"] = out_name
        if headers:
            opts["header"] = headers
        add_res = aria2_rpc("aria2.addUri", [[url], opts])
        gid = add_res.get("result")
        if not gid:
            raise RuntimeError("Failed to start download in aria2c.")

        cur_name = out_name or label or "Downloading..."
        final_path = None
        while True:
            st = (aria2_rpc("aria2.tellStatus", [gid]).get("result")) or {}
            if st.get("followedBy"):
                gid = st["followedBy"][0]
                continue

            status = st.get("status", "active")
            total_len = int(st.get("totalLength") or 0)
            done_len = int(st.get("completedLength") or 0)
            dl_spd = int(st.get("downloadSpeed") or 0)
            files = st.get("files") or []
            if files and files[0].get("path"):
                final_path = Path(files[0]["path"])
                cur_name = final_path.name

            pct = (100.0 * done_len / total_len) if total_len > 0 else 0.0
            eta = ((total_len - done_len) / dl_spd) if (dl_spd > 0 and total_len > done_len) else None
            try:
                self.tick(cur_name, "Download..", pct, done_len, total_len, dl_spd, eta, ARIA_ENGINE)
            except InterruptedError:
                aria2_rpc("aria2.forceRemove", [gid])
                raise

            if status == "complete":
                break
            if status in ("error", "removed"):
                raise RuntimeError(f"Download failed: {st.get('errorMessage') or 'unknown aria2c error'}")
            time.sleep(1.0)

        if not final_path or not final_path.exists():
            cands = [p for p in dest_dir.iterdir() if p.is_file() and not p.name.endswith(".aria2")]
            if not cands:
                raise RuntimeError("No file found after download completed.")
            final_path = max(cands, key=lambda p: p.stat().st_mtime)
        return final_path

    # ---------------- Subprocess with live progress (7-Zip / tar) ----------------

    def run_progress(self, cmd, filename, status_text, engine, total_bytes, cwd=None, estimate_dir: Path = None):
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=cwd)
        state = {"pct": None, "buf": ""}

        def reader():
            fd = proc.stdout.fileno()
            while True:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                s = chunk.decode("utf-8", "ignore")
                state["buf"] = (state["buf"] + s)[-16000:]
                found = re.findall(r"(\d{1,3})%", s)
                if found:
                    state["pct"] = min(100.0, float(found[-1]))

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        start = time.time()
        est_pct = 0.0
        last_est = 0.0
        try:
            while proc.poll() is None:
                pct = state["pct"]
                now = time.time()
                if pct is None and estimate_dir is not None and total_bytes > 0:
                    if now - last_est >= TICK_SECONDS:
                        last_est = now
                        est_pct = min(99.0, 100.0 * path_size(estimate_dir) / total_bytes)
                    pct = est_pct
                pct = pct or 0.0
                done = total_bytes * pct / 100.0
                elapsed = max(0.001, now - start)
                speed = done / elapsed
                eta = (total_bytes - done) / speed if speed > 0 else None
                self.tick(filename, status_text, pct, done, total_bytes, speed, eta, engine)
                time.sleep(0.5)
        except InterruptedError:
            proc.kill()
            proc.wait()
            raise
        t.join(timeout=3)
        return proc.returncode, state["buf"]

    # ---------------- Rclone ----------------

    def run_rclone(self, args: list, filename: str, status_text: str, size_hint: float, engine: str = "Rclone Drive"):
        global cancelled
        log_path = WORK_DIR / "rclone.log"
        log_path.unlink(missing_ok=True)
        cmd = ["rclone", *args,
               "--rc", "--rc-addr=127.0.0.1:5572", "--rc-no-auth",
               "--drive-chunk-size=128M", "--transfers=4", "--checkers=8",
               "--drive-stop-on-upload-limit", "--drive-stop-on-download-limit",
               "--retries=3", "--low-level-retries=10",
               "--log-level=ERROR", f"--log-file={log_path}"]
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL)
        last = 0.0
        last_bytes = 0.0
        try:
            while proc.poll() is None:
                if cancelled:
                    raise InterruptedError("Cancelled by user")
                now = time.time()
                if now - last >= TICK_SECONDS:
                    last = now
                    st = http_json("http://127.0.0.1:5572/core/stats", data={}, timeout=3)
                    done = float(st.get("bytes") or 0)
                    last_bytes = max(last_bytes, done)
                    total = float(st.get("totalBytes") or size_hint or 0)
                    spd = float(st.get("speed") or 0)
                    eta = st.get("eta")
                    if total > 0:
                        pct = 100.0 * done / total
                    else:
                        tt = float(st.get("totalTransfers") or 0)
                        pct = (100.0 * float(st.get("transfers") or 0) / tt) if tt > 0 else 0.0
                    self.tick(filename, status_text, min(100.0, pct), done, total, spd, eta, engine, force=True)
                time.sleep(1.0)
        except InterruptedError:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            raise

        if proc.returncode != 0:
            tail = ""
            try:
                tail = log_path.read_text(encoding="utf-8", errors="ignore")[-4000:]
            except OSError:
                pass
            last_line = tail.strip().splitlines()[-1] if tail.strip() else ""
            raise RuntimeError(
                friendly_drive_error(tail) or f"Rclone exited with code {proc.returncode}. {last_line[-200:]}".strip()
            )
        return int(last_bytes)

    # ---------------- Upload with conflict policy ----------------

    def upload_file(self, local: Path) -> dict:
        name = local.name
        size = path_size(local)
        action, final, ex = self.resolve_conflict(self.folder_id, name, False)
        if action == "skip":
            return self.finalize(ex, name, size, False, status="skipped")
        self.run_rclone(["copyto", str(local), remote_path(self.folder_id) + final], final, "Uploading..", size)
        f = self.lookup(self.folder_id, final)
        return self.finalize(f, final, size, False)

    def upload_dir(self, local: Path) -> dict:
        name = local.name
        size = path_size(local)
        action, final, ex = self.resolve_conflict(self.folder_id, name, True)
        if action == "skip":
            return self.finalize(ex, name, size, True, status="skipped")
        if action == "overwrite" and ex and ex.get("mimeType") == FOLDER_MIME:
            target = ex["id"]
        else:
            target = self.create_folder(self.folder_id, final)
        self.run_rclone(["copy", str(local), remote_path(target)], final, "Uploading..", size)
        return self.finalize({"id": target, "name": final, "mimeType": FOLDER_MIME}, final, size, True)

    # ---------------- Gofile (per-task guest account) ----------------

    def _gofile_pick_server(self) -> str:
        res = http_json("https://api.gofile.io/servers", headers={"User-Agent": "curl/8.5.0"}, timeout=15)
        servers = ((res.get("data") or {}).get("servers")) or []
        if servers and servers[0].get("name"):
            return f"{servers[0]['name']}.gofile.io"
        return "upload.gofile.io"

    def _gofile_upload_once(self, local: Path, host: str, path: str, folder_id: str = "", label: str = "") -> dict:
        global cancelled
        boundary = uuid.uuid4().hex
        parts = []
        if folder_id:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n{folder_id}\r\n'.encode("utf-8")
            )
        safe_name = local.name.replace('"', "_").replace("\r", "").replace("\n", "")
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{safe_name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode("utf-8")
        )
        prefix = b"".join(parts)
        suffix = f"\r\n--{boundary}--\r\n".encode("utf-8")
        file_size = local.stat().st_size
        total_len = len(prefix) + file_size + len(suffix)
        disp_name = label or local.name

        conn = http.client.HTTPSConnection(host, 443, timeout=180)
        try:
            conn.putrequest("POST", path)
            conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            conn.putheader("Content-Length", str(total_len))
            conn.putheader("User-Agent", "curl/8.5.0")
            conn.putheader("Accept", "*/*")
            if self.gofile_token:
                conn.putheader("Authorization", f"Bearer {self.gofile_token}")
            conn.endheaders()
            conn.send(prefix)

            sent = 0
            start = time.time()
            with open(local, "rb") as f:
                while True:
                    if cancelled:
                        raise InterruptedError("Cancelled by user")
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    conn.send(chunk)
                    sent += len(chunk)
                    now = time.time()
                    elapsed = max(0.001, now - start)
                    speed = sent / elapsed
                    pct = (100.0 * sent / file_size) if file_size > 0 else 100.0
                    eta = ((file_size - sent) / speed) if (speed > 0 and file_size > sent) else None
                    self.tick(disp_name, "Uploading..", min(99.9, pct), sent, file_size, speed, eta, "Gofile Stream")

            conn.send(suffix)
            self.tick(disp_name, "Finalizing..", 99.9, file_size, file_size, 0, None, "Gofile Stream", force=True)
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8", "replace")
            if resp.status in (301, 302, 307, 308):
                loc = resp.getheader("Location")
                if loc:
                    u = urllib.parse.urlparse(loc)
                    if u.hostname:
                        return self._gofile_upload_once(local, u.hostname, u.path or "/uploadfile", folder_id, label)
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {}
            if resp.status >= 400 or parsed.get("status") != "ok":
                err_code = parsed.get("status") or f"HTTP {resp.status}"
                raise RuntimeError(f"Gofile upload failed ({err_code}): {raw[:180]}")
            return parsed.get("data") or {}
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def gofile_upload_file(self, local: Path, folder_id: str = "", label: str = "") -> dict:
        last_err = None
        targets = [("upload.gofile.io", "/uploadfile")]
        for attempt in range(3):
            if attempt > 0:
                srv_host = self._gofile_pick_server()
                targets.append((srv_host, "/contents/uploadfile" if srv_host != "upload.gofile.io" else "/uploadfile"))
            host, path = targets[-1]
            try:
                data = self._gofile_upload_once(local, host, path, folder_id=folder_id, label=label)
                if not self.gofile_token and data.get("guestToken"):
                    self.gofile_token = data["guestToken"]
                    mask_secret(self.gofile_token)
                if not self.gofile_root_id and data.get("parentFolder"):
                    self.gofile_root_id = data["parentFolder"]
                    self.gofile_link = data.get("downloadPage") or f"https://gofile.io/d/{data.get('parentFolderCode', '')}"
                    self.gofile_folders[""] = self.gofile_root_id
                return data
            except InterruptedError:
                raise
            except Exception as e:
                last_err = e
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(str(last_err or "Gofile upload failed"))

    def gofile_create_folder(self, parent_id: str, name: str) -> str:
        res = http_json(
            "https://api.gofile.io/contents/createFolder",
            data={"parentFolderId": parent_id, "folderName": name},
            headers={"Authorization": f"Bearer {self.gofile_token}", "User-Agent": "curl/8.5.0"},
            method="POST",
            timeout=30,
        )
        fid = (res.get("data") or {}).get("id")
        if res.get("status") != "ok" or not fid:
            raise RuntimeError(f"Gofile folder creation failed ({res.get('status') or 'error'})")
        return fid

    def gofile_ensure_dir(self, rel_dir: Path) -> str:
        key = str(rel_dir)
        if key in ("", "."):
            return self.gofile_root_id
        if key in self.gofile_folders:
            return self.gofile_folders[key]
        parent_id = self.gofile_ensure_dir(rel_dir.parent)
        fid = self.gofile_create_folder(parent_id, rel_dir.name)
        self.gofile_folders[key] = fid
        return fid

    def upload_gofile(self, target: Path) -> dict:
        if target.is_file():
            size = path_size(target)
            d = self.gofile_upload_file(target, folder_id=self.gofile_root_id)
            return {
                "name": target.name,
                "link": d.get("downloadPage") or self.gofile_link,
                "id": d.get("id", ""),
                "size": size,
                "status": "completed",
                "isDir": False,
                "shared": True,
                "direct": "",
            }

        files = sorted(
            [p for p in target.rglob("*") if p.is_file()],
            key=lambda p: (len(p.relative_to(target).parts), str(p)),
        )
        if not files:
            raise RuntimeError("Directory is empty — nothing to upload.")

        total_size = path_size(target)
        for f in files:
            rel = f.relative_to(target)
            rel_parent = rel.parent
            if not self.gofile_root_id:
                self.gofile_upload_file(f, folder_id="", label=str(rel))
            else:
                fid = self.gofile_ensure_dir(rel_parent) if str(rel_parent) != "." else self.gofile_root_id
                self.gofile_upload_file(f, folder_id=fid, label=str(rel))

        return {
            "name": target.name,
            "link": self.gofile_link,
            "id": self.gofile_root_id,
            "size": total_size,
            "status": "completed",
            "isDir": True,
            "shared": True,
            "direct": "",
        }

    def upload(self, target: Path) -> dict:
        if self.dest == "gofile":
            return self.upload_gofile(target)
        self.ensure_token(max_age=10 * 60)
        return self.upload_dir(target) if target.is_dir() else self.upload_file(target)

    # ---------------- Google Drive sources ----------------

    def gdrive_meta(self, item: dict) -> dict:
        res = self.drive(
            "GET", f"files/{item['id']}",
            {"fields": "id,name,mimeType,size,webViewLink"},
            resource_key=item.get("resourceKey"),
        )
        if not res.get("id"):
            raise RuntimeError(drive_error_text(res, "Could not read Google Drive link"))
        return res

    def gdrive_copy_file(self, item: dict, meta: dict, name: str) -> dict:
        size = int(meta.get("size") or 0)
        self.tick(name, "Server Copy..", 50.0, 0, size, 0, None, "Drive Server-Side", force=True)
        action, final, ex = self.resolve_conflict(self.folder_id, name, False)
        if action == "skip":
            return self.finalize(ex, name, size, False, status="skipped")
        if action == "overwrite" and ex:
            self.drive("PATCH", f"files/{ex['id']}", {"fields": "id"}, body={"trashed": True})
        res = self.drive(
            "POST", f"files/{meta['id']}/copy",
            {"fields": "id,name,mimeType,webViewLink,size"},
            body={"name": final, "parents": [self.folder_id or "root"]},
            resource_key=item.get("resourceKey"),
            timeout=600,
        )
        if not res.get("id"):
            raise RuntimeError(drive_error_text(res, "Drive copy failed"))
        return self.finalize(res, final, int(res.get("size") or size), False)

    def gdrive_clone_folder(self, meta: dict, name: str) -> dict:
        action, final, ex = self.resolve_conflict(self.folder_id, name, True)
        if action == "skip":
            return self.finalize(ex, name, 0, True, status="skipped")
        if action == "overwrite" and ex and ex.get("mimeType") == FOLDER_MIME:
            target = ex["id"]
        else:
            target = self.create_folder(self.folder_id, final)
        rclone_bytes = self.run_rclone(
            ["copy", remote_path(meta["id"]), remote_path(target), "--drive-server-side-across-configs"],
            final, "Cloning..", 0, engine="Drive Server-Side",
        )
        f = {"id": target, "name": final, "mimeType": FOLDER_MIME}
        size = rclone_bytes
        if size <= 0:
            sz = self.drive("GET", "files", {
                "q": f"'{target}' in parents and trashed = false",
                "fields": "files(size)",
                "pageSize": "1000",
            })
            for x in sz.get("files") or []:
                size += int(x.get("size") or 0)
        return self.finalize(f, final, size, True)

    def gdrive_download_file(self, item: dict, meta: dict, dest_dir: Path, name: str) -> Path:
        self.ensure_token(max_age=5 * 60)  # aria2 headers are fixed for the whole download
        url = f"https://www.googleapis.com/drive/v3/files/{meta['id']}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true"
        headers = [f"Authorization: Bearer {self.access_token}"]
        if item.get("resourceKey"):
            headers.append(f"X-Goog-Drive-Resource-Keys: {meta['id']}/{item['resourceKey']}")
        return self.aria_download(url, dest_dir, out_name=name, headers=headers)

    def gdrive_download_folder(self, meta: dict, dest_dir: Path, name: str) -> Path:
        local = dest_dir / name
        local.mkdir(parents=True, exist_ok=True)
        self.ensure_token(max_age=10 * 60)
        self.run_rclone(["copy", remote_path(meta["id"]), str(local)], name, "Download..", 0)
        return local

    # ---------------- Archive processing ----------------

    def extract(self, archive: Path):
        name = archive.name
        size = path_size(archive)
        out = OUT_DIR / archive_stem(name)
        if out.exists():
            out = OUT_DIR / f"{archive_stem(name)}_{self.idx + 1}"
        out.mkdir(parents=True, exist_ok=True)

        low = name.lower()
        if low.endswith(TAR_SUFFIXES):
            rc, _ = self.run_progress(["tar", "-xf", str(archive), "-C", str(out)], name, "Extracting..", "GNU tar", size, estimate_dir=out)
            ok = rc == 0
        else:
            cmd = ["7z", "x", "-y", "-bsp1", "-bb0", f"-o{out}", str(archive)]
            if self.password:
                cmd.insert(2, f"-p{self.password}")
            rc, output = self.run_progress(cmd, name, "Extracting..", "7-Zip Engine", size, estimate_dir=out)
            lower = output.lower()
            if rc not in (0, 1) and ("wrong password" in lower or "enter password" in lower or "encrypted" in lower):
                shutil.rmtree(out, ignore_errors=True)
                raise RuntimeError(
                    "Wrong archive password." if self.password
                    else "Archive is password-protected. Set a password in the task options."
                )
            ok = rc in (0, 1) and any(out.iterdir())
            if not ok:
                shutil.rmtree(out, ignore_errors=True)
                out.mkdir(parents=True, exist_ok=True)
                rc2, _ = self.run_progress(["tar", "-xf", str(archive), "-C", str(out)], name, "Extracting..", "GNU tar", size, estimate_dir=out)
                ok = rc2 == 0

        if not ok:
            shutil.rmtree(out, ignore_errors=True)
            send_message(
                self.chat_id,
                f"<blockquote><b>Extraction Notice</b>\n\n<code>{html.escape(name)}</code>\n\n"
                f"Unsupported or corrupted archive. Uploading original file instead.</blockquote>",
            )
            return archive

        archive.unlink(missing_ok=True)

        if self.select_filter:
            exts = [e.strip().lower() for e in self.select_filter.split(",") if e.strip()]
            exts = [e if e.startswith(".") else "." + e for e in exts]
            if exts:
                for root, _, files_in_dir in os.walk(out):
                    for fn in files_in_dir:
                        if not any(fn.lower().endswith(ext) for ext in exts):
                            try:
                                (Path(root) / fn).unlink()
                            except OSError:
                                pass
                if path_size(out) == 0 and not any(p.is_file() for p in out.rglob("*")):
                    raise RuntimeError("No extracted files matched the Select filter.")
        return out

    def make_zip(self, sources: list, zip_name: str, cwd: Path, total_bytes: int):
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        zip_path = OUT_DIR / zip_name
        zip_path.unlink(missing_ok=True)
        cmd = ["7z", "a", "-tzip", "-mx=1", "-bsp1", "-bb0"]
        if self.password:
            cmd += [f"-p{self.password}", "-mem=AES256"]
        cmd += [str(zip_path), *sources]
        rc, _ = self.run_progress(cmd, zip_name, "Archiving ZIP", "7-Zip Fast", total_bytes, cwd=str(cwd))
        if rc in (0, 1) and zip_path.exists():
            return zip_path
        return None

    # ---------------- Item pipeline ----------------

    def item_label(self, item: dict) -> str:
        if item.get("name"):
            return item["name"]
        if item.get("type") == "gdrive":
            return f"drive:{item.get('id', '')}"
        try:
            seg = urllib.parse.urlparse(item.get("url", "")).path.rstrip("/").split("/")[-1]
            return urllib.parse.unquote(seg) or "link"
        except Exception:
            return "link"

    def single_name(self):
        return self.custom_name if (self.custom_name and not self.batch) else None

    def ytdl_download(self, url: str, dest_dir: Path):
        global cancelled
        self.tick(self.job.get("detectedName") or "Media", "Setting up yt-dlp..", 0.0, 0, 0, 0, None, "yt-dlp + FFmpeg", force=True)
        ensure_ytdl_tools()
        import yt_dlp
        from yt_dlp.utils import DownloadCancelled, download_range_func

        yt_dir = dest_dir / f"yt_{self.idx}"
        yt_dir.mkdir(parents=True, exist_ok=True)

        quality = self.job.get("ytQuality") or "best"
        container = self.job.get("ytContainer") or "mp4"
        is_audio = quality in YT_AUDIO_QUALITIES
        use_subs = bool(self.job.get("ytSubs")) and not is_audio
        sub_lang = (self.job.get("ytSubLang") or "en").strip() or "en"
        use_meta = self.job.get("ytMeta", True) is not False
        use_sb = bool(self.job.get("ytSponsorBlock"))
        pl_mode = self.job.get("ytPlaylist") or "single"
        pl_items = (self.job.get("ytPlaylistItems") or "").strip()
        trim_spec = (self.job.get("ytTrim") or "").strip()

        postprocessors = []
        if is_audio:
            postprocessors.append({
                "key": "FFmpegExtractAudio",
                "preferredcodec": quality,
                "preferredquality": "0",
            })
        if use_sb:
            cats = ["sponsor", "selfpromo", "interaction"]
            postprocessors.append({"key": "SponsorBlock", "categories": cats})
            postprocessors.append({"key": "ModifyChapters", "remove_sponsor_segments": cats})
        if use_subs and container in ("mp4", "mkv"):
            postprocessors.append({"key": "FFmpegEmbedSubtitle"})
        if use_meta:
            postprocessors.append({"key": "FFmpegMetadata", "add_chapters": True, "add_metadata": True})
            postprocessors.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})

        state = {
            "title": self.job.get("detectedName") or "Media",
            "playlist_title": "",
            "native_tick_at": time.time(),
            "phase": "Downloading (16x)..",
            "engine": "yt-dlp (16x)",
            "dl_phase": "Downloading (16x)..",
            "dl_engine": "yt-dlp (16x)",
        }

        def progress_hook(d):
            global cancelled
            if cancelled:
                raise DownloadCancelled("Cancelled by user")
            info = d.get("info_dict") or {}
            title = info.get("title") or state["title"]
            p_idx = info.get("playlist_index")
            p_cnt = info.get("n_entries")
            if p_idx and p_cnt and p_cnt > 1:
                disp = f"[{p_idx}/{p_cnt}] {title}"
            else:
                disp = title
            state["title"] = disp

            st = d.get("status")
            if st == "downloading":
                state["native_tick_at"] = time.time()
                done = float(d.get("downloaded_bytes") or 0)
                total = float(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
                spd = float(d.get("speed") or 0)
                eta = d.get("eta")
                pct = (100.0 * done / total) if total > 0 else 0.0
                try:
                    self.tick(disp, state["dl_phase"], min(99.9, pct), done, total, spd, eta, state["dl_engine"])
                except InterruptedError:
                    cancelled = True
                    raise DownloadCancelled("Cancelled by user")
            elif st == "finished":
                state["native_tick_at"] = time.time()
                state["phase"] = "Processing.."
                total = float(d.get("total_bytes") or d.get("downloaded_bytes") or 0)
                try:
                    self.tick(disp, "Processing..", 99.0, total, total, 0, None, state["dl_engine"], force=True)
                except InterruptedError:
                    cancelled = True
                    raise DownloadCancelled("Cancelled by user")

        def post_hook(d):
            global cancelled
            if cancelled:
                raise DownloadCancelled("Cancelled by user")
            st = d.get("status")
            if st == "started":
                state["native_tick_at"] = time.time()
                state["phase"] = "Merging (FFmpeg).."
                state["engine"] = "yt-dlp + FFmpeg"
                try:
                    self.tick(state["title"], "Merging (FFmpeg)..", 99.5, 0, 0, 0, None, "yt-dlp + FFmpeg", force=True)
                except InterruptedError:
                    cancelled = True
                    raise DownloadCancelled("Cancelled by user")
            elif st == "finished":
                state["native_tick_at"] = time.time()
                state["phase"] = state["dl_phase"]
                state["engine"] = state["dl_engine"]

        def build_ydl_opts(use_aria: bool, use_dashy: bool) -> dict:
            opts = {
                "format": ytdl_format_spec(quality, container),
                "outtmpl": str(yt_dir / "%(title).150B [%(id)s].%(ext)s"),
                "restrictfilenames": False,
                "noplaylist": (pl_mode != "all"),
                "ignoreerrors": (pl_mode == "all"),
                "writethumbnail": use_meta,
                "postprocessors": postprocessors,
                "progress_hooks": [progress_hook],
                "postprocessor_hooks": [post_hook],
                "concurrent_fragment_downloads": 16,
                "http_chunk_size": 10 * 1024 * 1024,
                "buffersize": 1024 * 1024,
                "retries": 10,
                "fragment_retries": 10,
                "file_access_retries": 5,
                "extractor_retries": 5,
                "quiet": True,
                "no_warnings": True,
                "noprogress": True,
            }
            if use_dashy:
                # Split YouTube HTTPS streams into 10 MiB &range= DASH segments for 16x native concurrency
                opts["extractor_args"] = {"youtube": {"formats": ["dashy"]}}
            elif use_aria:
                opts["external_downloader"] = {"http": "aria2c", "https": "aria2c"}
                opts["external_downloader_args"] = {
                    "aria2c": [
                        "-x", "16", "-s", "16", "-k", "1M",
                        "--file-allocation=none",
                        "--max-tries=5", "--retry-wait=2",
                        "--connect-timeout=15", "--timeout=30",
                        "--summary-interval=0",
                    ]
                }
            if shutil.which("node"):
                opts["js_runtimes"] = {"node": {}}
            if not is_audio and container in ("mp4", "mkv"):
                opts["merge_output_format"] = container
            if use_subs:
                opts["writesubtitles"] = True
                opts["writeautomaticsub"] = True
                opts["subtitleslangs"] = [s.strip() for s in sub_lang.split(",") if s.strip()] or ["en"]
                opts["subtitlesformat"] = "srt/best"
            if pl_mode == "all" and pl_items:
                opts["playlist_items"] = pl_items
            if trim_spec:
                rng = parse_trim_range(trim_spec)
                if rng:
                    opts["download_ranges"] = download_range_func(None, [rng])
                    opts["force_keyframes_at_cuts"] = True
            return opts

        is_yt = _is_youtube_url(url)
        use_dashy_primary = is_yt and not trim_spec
        use_aria_primary = bool(shutil.which("aria2c")) and not is_yt and not trim_spec
        cookie_path = prepare_ytdl_cookiefile()

        def run_ydl(use_aria: bool, use_dashy: bool):
            global cancelled
            opts = build_ydl_opts(use_aria, use_dashy)
            if cookie_path:
                opts["cookiefile"] = str(cookie_path)
            dl_engine = "yt-dlp (16x)" if use_dashy else ("yt-dlp + Aria2c" if use_aria else "yt-dlp + FFmpeg")
            dl_phase = "Downloading (16x).." if (use_dashy or use_aria) else "Downloading.."
            state["engine"] = dl_engine
            state["phase"] = dl_phase
            state["dl_engine"] = dl_engine
            state["dl_phase"] = dl_phase

            stop_mon = threading.Event()

            def monitor():
                global cancelled
                prev_bytes = _ytdir_written_bytes(yt_dir)
                prev_t = time.time()
                while not stop_mon.wait(1.0):
                    if cancelled:
                        _kill_child_procs()
                        break
                    now = time.time()
                    if now - state["native_tick_at"] < 3.0:
                        prev_bytes = _ytdir_written_bytes(yt_dir)
                        prev_t = now
                        continue
                    cur_bytes = _ytdir_written_bytes(yt_dir)
                    dt = max(0.001, now - prev_t)
                    spd = max(0.0, (cur_bytes - prev_bytes) / dt)
                    prev_bytes = cur_bytes
                    prev_t = now
                    try:
                        self.tick(state["title"], state["phase"], 0.0, cur_bytes, 0, spd, None, state["engine"])
                    except InterruptedError:
                        cancelled = True
                        _kill_child_procs()
                        break

            mon_thread = threading.Thread(target=monitor, daemon=True)
            mon_thread.start()
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    if isinstance(info, dict):
                        state["playlist_title"] = info.get("title") or ""
            finally:
                stop_mon.set()
                mon_thread.join(timeout=2)

        try:
            try:
                run_ydl(use_aria_primary, use_dashy_primary)
            except DownloadCancelled:
                raise
            except Exception:
                if cancelled or not (use_aria_primary or use_dashy_primary):
                    raise
                # Accelerated path failed (e.g. live/no-clen YouTube or strict CDN); clean partial files and fall back
                for p in list(yt_dir.iterdir()):
                    if p.is_file() and (p.name.endswith((".aria2", ".part", ".temp")) or ".part-Frag" in p.name):
                        p.unlink(missing_ok=True)
                state["native_tick_at"] = time.time()
                self.tick(state["title"], "Retrying (Native)..", 0.0, 0, 0, 0, None, "yt-dlp + FFmpeg", force=True)
                run_ydl(False, False)
        except DownloadCancelled:
            raise InterruptedError("Cancelled by user")
        except Exception as e:
            if cancelled:
                raise InterruptedError("Cancelled by user")
            raise RuntimeError(friendly_ytdl_error(str(e)))
        finally:
            if cookie_path:
                cookie_path.unlink(missing_ok=True)

        if cancelled:
            raise InterruptedError("Cancelled by user")

        files = [
            p for p in yt_dir.iterdir()
            if p.is_file() and not p.name.endswith((".part", ".ytdl", ".temp"))
        ]
        # Drop stray unembedded thumbnail images if actual media files exist
        media_files = [p for p in files if p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp")]
        if media_files:
            for img in files:
                if img not in media_files:
                    img.unlink(missing_ok=True)
            files = media_files

        if not files:
            raise RuntimeError("yt-dlp finished without producing any downloadable media file.")

        if len(files) == 1:
            f = files[0]
            custom = self.single_name()
            if custom:
                has_ext = "." in Path(custom).name and len(Path(custom).suffix) <= 10
                new_name = custom if has_ext else f"{custom}{f.suffix}"
                renamed = f.with_name(new_name)
                if renamed != f:
                    f.rename(renamed)
                    f = renamed
            return f

        # Multiple files (playlist or external subtitle files): wrap in a cleanly named folder
        raw_dir_name = self.single_name() or state["playlist_title"] or f"Playlist_{JOB_ID}"
        safe_dir_name = re.sub(r'[/\\?%*:|"<>]', "_", raw_dir_name).strip() or f"Playlist_{JOB_ID}"
        bundle = dest_dir / safe_dir_name
        if bundle.exists():
            bundle = dest_dir / f"{safe_dir_name}_{self.idx + 1}"
        bundle.mkdir(parents=True, exist_ok=True)
        for f in files:
            shutil.move(str(f), str(bundle / f.name))
        shutil.rmtree(yt_dir, ignore_errors=True)
        return bundle

    def resolve_item(self, item: dict) -> dict:
        if item.get("_resolved") or item.get("type") in ("gdrive", "ytdl"):
            return item
        target = item.get("sourceUrl") or item.get("url") or ""
        if not target:
            return item
        if is_media_site_url(target):
            return {"type": "ytdl", "url": target, "name": item.get("name") or target, "_resolved": True}
        # Only resolve on runner when batch (not pre-resolved) or sourceUrl is present (IP-bound page extractor)
        if not self.batch and not item.get("sourceUrl"):
            return item
        try:
            resolved = resolve_download_url(target)
            if resolved.get("type") == "gdrive":
                resolved["_resolved"] = True
                return resolved
            if resolved.get("url"):
                updated = dict(item)
                updated["url"] = resolved["url"]
                updated["_resolved"] = True
                return updated
        except Exception as e:
            if item.get("sourceUrl") and item.get("url"):
                return item
            raise RuntimeError(str(e))
        return item

    def acquire_local(self, item: dict, dest_dir: Path) -> Path:
        """Downloads an item to local disk (used for extract/zip modes, yt-dlp, and URL items)."""
        item = self.resolve_item(item)
        if item.get("type") == "ytdl":
            return self.ytdl_download(item["url"], dest_dir)
        if item.get("type") == "gdrive":
            meta = self.gdrive_meta(item)
            name = self.single_name() or meta["name"]
            mime = meta.get("mimeType", "")
            if mime == FOLDER_MIME:
                return self.gdrive_download_folder(meta, dest_dir, name)
            if mime.startswith("application/vnd.google-apps."):
                raise RuntimeError("Google Docs/Sheets/Slides files cannot be downloaded for archiving.")
            return self.gdrive_download_file(item, meta, dest_dir, name)
        return self.aria_download(item["url"], dest_dir, out_name=self.single_name(), label=self.item_label(item))

    def process_and_upload(self, local: Path) -> dict:
        size = path_size(local)
        mode = self.mode
        if mode in ("extract", "zip"):
            du_free = shutil.disk_usage("/").free
            if du_free < size * 1.15:
                send_message(
                    self.chat_id,
                    f"<blockquote><b>Workspace Notice</b>\n\n"
                    f"Remaining disk (<code>{fmt_bytes(du_free)}</code>) is tight for archive processing. "
                    f"Uploading original directly.</blockquote>",
                )
                mode = "normal"

        target = local
        if mode == "extract" and local.is_file():
            target = self.extract(local)
        elif mode == "zip":
            zip_name = local.name if (local.is_file() and local.name.lower().endswith(".zip")) else local.name + ".zip"
            zipped = self.make_zip([local.name], zip_name, local.parent, size)
            if zipped:
                if local.is_dir():
                    shutil.rmtree(local, ignore_errors=True)
                else:
                    local.unlink(missing_ok=True)
                target = zipped
        return self.upload(target)

    def process_item(self, item: dict, item_dir: Path) -> dict:
        item = self.resolve_item(item)
        if item.get("type") == "gdrive":
            if not self.access_token:
                if item.get("url"):
                    local = self.aria_download(item["url"], item_dir, out_name=self.single_name(), label=self.item_label(item))
                    return self.process_and_upload(local)
                rk = f"&resourcekey={urllib.parse.quote(item['resourceKey'])}" if item.get("resourceKey") else ""
                pub_url = f"https://drive.usercontent.google.com/download?id={urllib.parse.quote(item['id'])}&export=download&confirm=t{rk}"
                local = self.aria_download(pub_url, item_dir, out_name=self.single_name(), label=self.item_label(item))
                return self.process_and_upload(local)
            meta = self.gdrive_meta(item)
            name = self.single_name() or meta["name"]
            mime = meta.get("mimeType", "")
            if self.dest != "gofile":
                if mime == FOLDER_MIME and self.mode != "zip":
                    return self.gdrive_clone_folder(meta, name)
                if mime != FOLDER_MIME and (self.mode == "normal" or mime.startswith("application/vnd.google-apps.")):
                    return self.gdrive_copy_file(item, meta, name)
        local = self.acquire_local(item, item_dir)
        return self.process_and_upload(local)

    def run_batch_zip(self) -> list:
        bdir = DL_DIR / "batch"
        bdir.mkdir(parents=True, exist_ok=True)
        results = []
        for i, item in enumerate(self.items):
            self.idx = i
            try:
                self.acquire_local(item, bdir)
            except InterruptedError:
                raise
            except Exception as e:
                results.append({"name": self.item_label(item), "status": "failed", "error": str(e)[:200]})
        if not any(bdir.iterdir()):
            return results
        zip_name = self.custom_name or f"Batch_{JOB_ID}.zip"
        if not zip_name.lower().endswith(".zip"):
            zip_name += ".zip"
        total = path_size(bdir)
        zipped = self.make_zip(["*"], zip_name, bdir, total)
        if not zipped:
            raise RuntimeError("Failed to create batch ZIP archive.")
        shutil.rmtree(bdir, ignore_errors=True)
        results.insert(0, self.upload(zipped))
        return results

    def run(self) -> list:
        DL_DIR.mkdir(parents=True, exist_ok=True)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        if self.access_token:
            self.start_token_server()
            self.write_rclone_conf()

        if self.batch and self.mode == "zip":
            return self.run_batch_zip()

        results = []
        for i, item in enumerate(self.items):
            self.idx = i
            item_dir = DL_DIR / f"item_{i}"
            try:
                results.append(self.process_item(item, item_dir))
            except InterruptedError:
                raise
            except Exception as e:
                if not self.batch:
                    raise
                results.append({"name": self.item_label(item), "status": "failed", "error": str(e)[:200]})
            finally:
                shutil.rmtree(item_dir, ignore_errors=True)
                for p in list(OUT_DIR.iterdir()) if OUT_DIR.exists() else []:
                    shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        return results

    # ---------------- Final report ----------------

    def uname(self) -> str:
        u = self.job.get("username") or "User"
        return u if (u.startswith("@") or u == "User") else "@" + u

    def report(self, results: list):
        elapsed = fmt_duration(time.time() - self.task_start)
        ok = [r for r in results if r.get("status") in ("completed", "skipped")]
        overall = "completed" if ok else "failed"
        is_gofile = self.dest == "gofile"

        if not self.batch and len(results) == 1:
            r = results[0]
            if r.get("status") == "failed":
                raise RuntimeError(r.get("error") or "Transfer failed")
            title = "Transfer Complete" if r["status"] == "completed" else "Skipped — Already Exists"
            text = (
                f"<blockquote><b>{title}</b>\n\n"
                f"<code>{html.escape(r['name'])}</code></blockquote>\n\n"
                f"Size  ·  <code>{fmt_bytes(r.get('size', 0))}</code>\n\n"
            )
            if is_gofile:
                text += "Dest  ·  Gofile (Guest Session)\n\nAccess  ·  Public Link\n\n"
            else:
                text += f"Folder  ·  {html.escape(self.folder_name)}\n\n"
                if r.get("shared"):
                    text += "Access  ·  Anyone with the link\n\n"
            text += f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
            if is_gofile:
                text += f"\n\n<blockquote>{GOFILE_NOTICE_HTML}</blockquote>"
                rows = [[{"text": "▸  Open Gofile Folder" if r.get("isDir") else "▸  Open Gofile", "url": r["link"], "style": "success"}]]
            else:
                rows = [[
                    {"text": "▸  Open Folder" if r.get("isDir") else "▸  Open File", "url": r["link"], "style": "success"},
                    {"text": "Open Folder", "url": self.folder_url(), "style": "primary"},
                ]]
                if r.get("direct"):
                    rows.append([{"text": "⬇ Direct Download", "url": r["direct"], "style": "primary"}])
            kb = {"inline_keyboard": rows}
        else:
            header = (
                f"<blockquote><b>{'Batch Complete' if ok else 'Batch Failed'}</b>\n\n"
                f"<code>{len(ok)} / {len(results)} succeeded</code></blockquote>\n\n"
            )
            dest_line = "Dest  ·  Gofile (Guest Session)" if is_gofile else f"Folder  ·  {html.escape(self.folder_name)}"
            warn_block = f"\n\n<blockquote>{GOFILE_NOTICE_HTML}</blockquote>" if (is_gofile and ok) else ""
            footer = (
                f"\n{dest_line}\n\n"
                f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
                f"{warn_block}"
            )
            body = ""
            for n, r in enumerate(results, 1):
                name = html.escape(truncate(r.get("name", "item"), 48))
                if r.get("status") == "completed":
                    line = f"{n}. ✓ <a href=\"{html.escape(r['link'], quote=True)}\">{name}</a>  <code>{fmt_bytes(r.get('size', 0))}</code>\n"
                elif r.get("status") == "skipped":
                    line = f"{n}. ↷ <a href=\"{html.escape(r['link'], quote=True)}\">{name}</a>  <i>exists, skipped</i>\n"
                else:
                    line = f"{n}. ✗ <code>{name}</code>\n    <i>{html.escape(truncate(r.get('error', 'failed'), 120))}</i>\n"
                if len(header) + len(body) + len(line) + len(footer) > 3900:
                    body += f"\n<i>…and {len(results) - n + 1} more. See /history.</i>\n"
                    break
                body += line
            text = header + body + footer
            if is_gofile:
                kb = {"inline_keyboard": [[{"text": "▸  Open Gofile Folder", "url": self.gofile_link, "style": "success"}]]} if self.gofile_link else None
            else:
                kb = {"inline_keyboard": [[{"text": "▸  Open Folder", "url": self.folder_url(), "style": "success"}]]}

        _, synced_msg_id = sync_worker_state(JOB_ID)
        if synced_msg_id is not None:
            self.message_id = synced_msg_id
        finish_status(self.chat_id, self.message_id, text, kb)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": overall, "items": results})


def main():
    if not WORKER_URL or not JOB_SECRET or not JOB_ID:
        print("Missing WORKER_URL, JOB_SECRET, or JOB_ID", flush=True)
        sys.exit(1)

    mask_secret(JOB_SECRET)
    mask_secret(BOT_TOKEN)

    init_res = worker_call("/internal/job", {"job_id": JOB_ID, "run_id": GITHUB_RUN_ID})
    if not init_res.get("ok"):
        print("Failed to fetch job from worker:", init_res.get("error"), flush=True)
        sys.exit(1)

    job = init_res["job"]
    access_token = job.get("accessToken") or ""
    mask_secret(access_token)
    mask_secret(job.get("fileUrl", ""))

    m = Mirror(job, access_token, job.get("tokenExpiry"))
    display = job.get("customName") or job.get("detectedName") or "Task"

    try:
        results = m.run()
        m.report(results)
    except InterruptedError:
        text = (
            f"<blockquote><b>Task Cancelled</b>\n\n"
            f"<code>{html.escape(display)}</code></blockquote>\n\n"
            f"Task ID  ·  <code>{html.escape(JOB_ID)}</code>"
        )
        _, synced = sync_worker_state(JOB_ID)
        if synced is not None:
            m.message_id = synced
        finish_status(m.chat_id, m.message_id, text)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "cancelled"})
    except Exception as e:
        reason = friendly_drive_error(str(e)) or str(e)
        text = (
            f"<blockquote><b>Transfer Failed</b>\n\n"
            f"<code>{html.escape(display)}</code></blockquote>\n\n"
            f"Reason  ·  <code>{html.escape(reason[:300])}</code>"
        )
        _, synced = sync_worker_state(JOB_ID)
        if synced is not None:
            m.message_id = synced
        finish_status(m.chat_id, m.message_id, text)
        worker_call("/internal/complete", {
            "job_id": JOB_ID,
            "status": "failed",
            "error": reason[:300],
            "items": [{"name": display, "status": "failed", "error": reason[:200]}],
        })
        sys.exit(1)
    finally:
        m.stop_aria()
        m.stop_token_server()


if __name__ == "__main__":
    main()
