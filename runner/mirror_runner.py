#!/usr/bin/env python3
"""
On-Demand Gigabit Mirror Runner for GitHub Actions — Refined UI Edition.
- Native Telegram <blockquote> file cards & <pre><code class="language-SYSTEM"> aligned telemetry blocks
- Custom Unicode Mathematical Sans-Serif Bold & Regular typography
- Colored InlineKeyboardButtons (style: "primary" | "danger" | "success")
- Spacious, breathable layout with zero emoji clutter
"""

import html
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
JOB_SECRET = os.environ.get("JOB_SECRET", "")
JOB_ID = os.environ.get("JOB_ID", "")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
GITHUB_RUN_ID = os.environ.get("GITHUB_RUN_ID", "")

WORK_DIR = Path("/tmp/mirror_work")
DL_DIR = WORK_DIR / "downloads"
OUT_DIR = WORK_DIR / "output"

cancelled = False

SANS_BOLD = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵",
)
SANS_REG = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "𝖠𝖡𝖢𝖣𝖤𝖥𝖦𝖧𝖨𝖩𝖪𝖫𝖬𝖭𝖮𝖯𝖰𝖱𝖲𝖳𝖴𝖵𝖶𝖷𝖸𝖹𝖺𝖻𝖼𝖽𝖾𝖿𝗀𝗁𝗂𝗃𝗄𝗅𝗆𝗇𝗈𝗉𝗊𝗋𝗌𝗍𝗎𝗏𝗐𝗑𝗒𝗓𝟢𝟣𝟤𝟥𝟦𝟧𝟨𝟩𝟪𝟫",
)


def sb(text: str) -> str:
    return str(text).translate(SANS_BOLD)


def sr(text: str) -> str:
    return str(text).translate(SANS_REG)


def handle_sig(signum, frame):
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, handle_sig)
signal.signal(signal.SIGINT, handle_sig)


def mask_secret(val: str):
    if val and len(val) > 4:
        print(f"::add-mask::{val}", flush=True)


def http_json(url: str, data: dict = None, headers: dict = None, method: str = None, timeout: int = 15):
    req_headers = {"Content-Type": "application/json", "User-Agent": "MirrorRunner/2.1"}
    if headers:
        req_headers.update(headers)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method or ("POST" if body else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
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
    if num <= 0:
        return "0.00 B"
    for unit in ["B", "KiB", "MiB", "GiB", "TiB"]:
        if abs(num) < 1024.0:
            return f"{num:.2f} {unit}"
        num /= 1024.0
    return f"{num:.2f} PiB"


def fmt_duration(seconds: float) -> str:
    if seconds is None or seconds < 0 or seconds > 86400 * 7:
        return "—"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h {m:02d}m {s:02d}s"
    if m > 0:
        return f"{m}m {s:02d}s"
    return f"{s}s"


def make_bar(pct: float, length: int = 12) -> str:
    pct = max(0.0, min(100.0, pct))
    filled = int(round((pct / 100.0) * length))
    return "■" * filled + "□" * (length - filled)


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
            total = sum(parts)
            return idle, total
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
        free_gb = du.free / (1024 ** 3)
        disk_used_pct = 100.0 * du.used / max(1, du.total)

        rx2, tx2 = self._read_net()
        rx_spd = max(0.0, (rx2 - self.prev_net[0]) / dt)
        tx_spd = max(0.0, (tx2 - self.prev_net[1]) / dt)
        self.prev_net = (rx2, tx2)
        self.prev_time = now

        return {
            "cpu_pct": cpu_pct,
            "ram_pct": ram_pct,
            "free_gb": free_gb,
            "disk_pct": disk_used_pct,
            "rx_spd": fmt_bytes(rx_spd) + "/s",
            "tx_spd": fmt_bytes(tx_spd) + "/s",
            "rx_tot": fmt_bytes(max(0, rx2 - self.base_rx)),
            "tx_tot": fmt_bytes(max(0, tx2 - self.base_tx)),
            "uptime": fmt_duration(now - self.start_time),
        }


def build_status_card(
    job: dict,
    filename: str,
    status_text: str,
    pct: float,
    done_bytes: float,
    total_bytes: float,
    speed_bps: float,
    eta_sec: float,
    engine: str,
    elapsed_sec: float,
    sys_snap: dict,
) -> str:
    mode_map = {"normal": "Mirror", "extract": "Extract", "zip": "ArchiveZIP"}
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

    total_str = fmt_bytes(total_bytes) if total_bytes > 0 else "Unknown"
    done_str = fmt_bytes(done_bytes)

    sys_block = (
        f"┌ 𝗦𝗬𝗦𝗧𝗘𝗠 𝗠𝗢𝗡𝗜𝗧𝗢𝗥\n"
        f"├ CPU   [{cpu_bar}] {sys_snap['cpu_pct']:5.1f}%\n"
        f"├ RAM   [{ram_bar}] {sys_snap['ram_pct']:5.1f}%\n"
        f"├ DISK  [{disk_bar}] {sys_snap['free_gb']:5.1f} GB free\n"
        f"│\n"
        f"├ SPD   ↓ {sys_snap['rx_spd']:<12} ↑ {sys_snap['tx_spd']}\n"
        f"├ NET   ↓ {sys_snap['rx_tot']:<12} ↑ {sys_snap['tx_tot']}\n"
        f"└ UPT   {sys_snap['uptime']}"
    )

    lines = [
        f"<blockquote><b>{sb('FILE')}</b>\n<code>{html.escape(filename)}</code></blockquote>",
        "",
        f"┌ <b>{sb('Status')}</b>      <code>{html.escape(status_text)} ({pct:.2f}%)</code>",
        f"├ <code>[{bar}]</code>",
        "│",
        f"├ <b>{sb('Speed')}</b>       <code>{fmt_bytes(speed_bps)}/s</code>",
        f"├ <b>{sb('Progress')}</b>    <code>{done_str}</code> / <code>{total_str}</code>",
        f"├ <b>{sb('ETA')}</b>         <code>{fmt_duration(eta_sec)}</code>  <i>({fmt_duration(elapsed_sec)})</i>",
        "│",
        f"├ <b>{sb('User')}</b>        {html.escape(uname)}  [<code>{html.escape(str(uid))}</code>]",
        f"├ <b>{sb('Engine')}</b>      <code>{html.escape(engine)}</code>  •  #{mode_str}",
        f"└ <b>{sb('Cancel')}</b>      /cancel_{html.escape(short_id)}",
        "",
        f"<pre><code class=\"language-SYSTEM\">{html.escape(sys_block)}</code></pre>",
    ]
    return "\n".join(lines)


def status_keyboard(job_id: str) -> dict:
    return {
        "inline_keyboard": [
            [
                {"text": "Refresh", "callback_data": f"st_ref:{job_id}", "style": "primary"},
                {"text": "Close", "callback_data": f"st_close:{job_id}", "style": "danger"},
            ],
            [
                {"text": "Cancel Task", "callback_data": f"st_cancel:{job_id}", "style": "danger"},
            ],
        ]
    }


def aria2_rpc(method: str, params: list = None):
    payload = {
        "jsonrpc": "2.0",
        "id": "1",
        "method": method,
        "params": params or [],
    }
    return http_json("http://127.0.0.1:6800/jsonrpc", data=payload, timeout=5)


def check_worker_cancelled(job_id: str) -> bool:
    res = worker_call("/internal/job-status", {"job_id": job_id})
    if res.get("cancelled"):
        return True
    return False


def write_rclone_conf(access_token: str):
    conf_dir = Path.home() / ".config" / "rclone"
    conf_dir.mkdir(parents=True, exist_ok=True)
    token_json = json.dumps({
        "access_token": access_token,
        "token_type": "Bearer",
        "expiry": "2099-01-01T00:00:00Z",
    })
    conf_text = f"[userdrive]\ntype = drive\nscope = drive\ntoken = {token_json}\n"
    conf_file = conf_dir / "rclone.conf"
    conf_file.write_text(conf_text, encoding="utf-8")
    os.chmod(conf_file, 0o600)


def query_drive_link(access_token: str, folder_id: str, name: str, is_dir: bool = False) -> str:
    parent = folder_id if folder_id else "root"
    safe_name = name.replace("'", "\\'")
    q = f"'{parent}' in parents and name = '{safe_name}' and trashed = false"
    url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode({
        "q": q,
        "fields": "files(id,name,webViewLink,mimeType)",
        "pageSize": 5,
    })
    res = http_json(url, headers={"Authorization": f"Bearer {access_token}"})
    files = res.get("files") or []
    if files:
        f = files[0]
        if f.get("webViewLink"):
            return f["webViewLink"]
        fid = f.get("id")
        if fid:
            if is_dir or f.get("mimeType") == "application/vnd.google-apps.folder":
                return f"https://drive.google.com/drive/folders/{fid}"
            return f"https://drive.google.com/file/d/{fid}/view"
    if folder_id and folder_id != "root":
        return f"https://drive.google.com/drive/folders/{folder_id}"
    return "https://drive.google.com/drive/my-drive"


def create_drive_subfolder(access_token: str, parent_id: str, folder_name: str) -> str:
    parent = parent_id if parent_id else "root"
    payload = {
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent],
    }
    res = http_json(
        "https://www.googleapis.com/drive/v3/files?fields=id,webViewLink",
        data=payload,
        headers={"Authorization": f"Bearer {access_token}"},
        method="POST",
    )
    return res.get("id", parent)


def main():
    global cancelled
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
    file_url = job["fileUrl"]
    chat_id = job["chatId"]
    message_id = job.get("messageId")
    folder_id = job.get("folderId") or "root"
    folder_name = job.get("folderName") or "My Drive"
    custom_name = (job.get("customName") or "").strip()
    mode = job.get("mode") or "normal"
    select_filter = (job.get("selectFilter") or "").strip()
    access_token = job.get("accessToken") or ""

    mask_secret(access_token)
    mask_secret(file_url)

    DL_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    sys_mon = SystemMonitor()
    task_start = time.time()

    aria_proc = subprocess.Popen(
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
        ]
    )
    time.sleep(1.0)

    try:
        opts = {}
        if custom_name:
            opts["out"] = custom_name
        add_res = aria2_rpc("aria2.addUri", [[file_url], opts])
        gid = add_res.get("result")
        if not gid:
            raise RuntimeError(f"Failed to start download in aria2c: {add_res}")

        last_edit = 0.0
        last_cancel_check = 0.0
        cur_filename = custom_name or job.get("detectedName") or "Downloading..."
        total_len = 0
        done_len = 0

        while True:
            if cancelled:
                aria2_rpc("aria2.forceRemove", [gid])
                raise InterruptedError("Cancelled by user")

            now = time.time()
            if now - last_cancel_check >= 5.0:
                last_cancel_check = now
                if check_worker_cancelled(JOB_ID):
                    cancelled = True
                    aria2_rpc("aria2.forceRemove", [gid])
                    raise InterruptedError("Cancelled by user")

            st_res = aria2_rpc("aria2.tellStatus", [gid])
            st = st_res.get("result") or {}
            if st.get("followedBy"):
                gid = st["followedBy"][0]
                continue

            status = st.get("status", "active")
            total_len = int(st.get("totalLength") or 0)
            done_len = int(st.get("completedLength") or 0)
            dl_spd = int(st.get("downloadSpeed") or 0)

            files = st.get("files") or []
            if files and files[0].get("path"):
                cur_filename = Path(files[0]["path"]).name

            pct = (100.0 * done_len / total_len) if total_len > 0 else 0.0
            eta = ((total_len - done_len) / dl_spd) if (dl_spd > 0 and total_len > done_len) else None

            if now - last_edit >= 2.5:
                last_edit = now
                snap = sys_mon.snapshot()
                card = build_status_card(
                    job=job,
                    filename=cur_filename,
                    status_text="Downloading",
                    pct=pct,
                    done_bytes=done_len,
                    total_bytes=total_len,
                    speed_bps=dl_spd,
                    eta_sec=eta,
                    engine="Aria2c v1.37",
                    elapsed_sec=now - task_start,
                    sys_snap=snap,
                )
                edit_status(chat_id, message_id, card, status_keyboard(JOB_ID))

            if status == "complete":
                break
            if status in ("error", "removed"):
                err_msg = st.get("errorMessage") or "Download failed"
                raise RuntimeError(f"Aria2c error: {err_msg}")

            time.sleep(1.0)

        dl_files = [p for p in DL_DIR.iterdir() if p.is_file() and not p.name.endswith(".aria2")]
        if not dl_files:
            raise RuntimeError("No file found after download completed.")
        downloaded_path = dl_files[0]
        cur_filename = downloaded_path.name
        file_size = downloaded_path.stat().st_size

        du_free = shutil.disk_usage("/").free
        upload_target_path = downloaded_path
        upload_is_dir = False

        if mode in ("extract", "zip"):
            if du_free < file_size * 1.15:
                send_message(
                    chat_id,
                    f"<blockquote><b>{sb('WORKSPACE NOTICE')}</b>\n"
                    f"{sr('Remaining disk')} (<code>{fmt_bytes(du_free)}</code>) {sr('is tight for archive extraction. Uploading original file directly.')}</blockquote>",
                )
                mode = "normal"

        if mode == "extract":
            snap = sys_mon.snapshot()
            card = build_status_card(
                job=job,
                filename=cur_filename,
                status_text="Extracting",
                pct=50.0,
                done_bytes=file_size,
                total_bytes=file_size,
                speed_bps=0,
                eta_sec=None,
                engine="7-Zip Engine",
                elapsed_sec=time.time() - task_start,
                sys_snap=snap,
            )
            edit_status(chat_id, message_id, card, status_keyboard(JOB_ID))

            base_stem = downloaded_path.stem
            for suffix in [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz"]:
                if cur_filename.lower().endswith(suffix):
                    base_stem = cur_filename[: -len(suffix)]
                    break
            extract_subdir = OUT_DIR / base_stem
            extract_subdir.mkdir(parents=True, exist_ok=True)

            ext_cmd = ["7z", "x", "-y", f"-o{extract_subdir}", str(downloaded_path)]
            res = subprocess.run(ext_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if res.returncode != 0:
                tar_res = subprocess.run(["tar", "-xf", str(downloaded_path), "-C", str(extract_subdir)])
                if tar_res.returncode != 0:
                    send_message(
                        chat_id,
                        f"<blockquote><b>{sb('EXTRACTION NOTICE')}</b>\n{sr('Unsupported archive format. Uploading original file instead.')}</blockquote>",
                    )
                    upload_target_path = downloaded_path
                    upload_is_dir = False
                else:
                    downloaded_path.unlink(missing_ok=True)
                    upload_target_path = extract_subdir
                    upload_is_dir = True
                    cur_filename = extract_subdir.name
            else:
                downloaded_path.unlink(missing_ok=True)
                upload_target_path = extract_subdir
                upload_is_dir = True
                cur_filename = extract_subdir.name

            if upload_is_dir and select_filter:
                exts = [e.strip().lower() for e in select_filter.split(",") if e.strip()]
                if exts:
                    for root, _, files_in_dir in os.walk(upload_target_path):
                        for fn in files_in_dir:
                            if not any(fn.lower().endswith(ext) for ext in exts):
                                try:
                                    (Path(root) / fn).unlink()
                                except Exception:
                                    pass

        elif mode == "zip":
            snap = sys_mon.snapshot()
            zip_name = cur_filename + ".zip" if not cur_filename.lower().endswith(".zip") else cur_filename
            card = build_status_card(
                job=job,
                filename=zip_name,
                status_text="Archiving ZIP",
                pct=50.0,
                done_bytes=file_size,
                total_bytes=file_size,
                speed_bps=0,
                eta_sec=None,
                engine="7-Zip Fast",
                elapsed_sec=time.time() - task_start,
                sys_snap=snap,
            )
            edit_status(chat_id, message_id, card, status_keyboard(JOB_ID))

            zip_path = OUT_DIR / zip_name
            z_res = subprocess.run(
                ["7z", "a", "-tzip", "-mx=1", str(zip_path), str(downloaded_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            if z_res.returncode == 0 and zip_path.exists():
                downloaded_path.unlink(missing_ok=True)
                upload_target_path = zip_path
                cur_filename = zip_path.name
                file_size = zip_path.stat().st_size

        ref_res = worker_call("/internal/refresh", {"job_id": JOB_ID})
        if ref_res.get("ok") and ref_res.get("accessToken"):
            access_token = ref_res["accessToken"]
            mask_secret(access_token)

        write_rclone_conf(access_token)

        target_drive_folder_id = folder_id if folder_id else "root"
        if upload_is_dir:
            target_drive_folder_id = create_drive_subfolder(access_token, folder_id, cur_filename)

        rclone_dest = (
            f"userdrive,root_folder_id={target_drive_folder_id}:"
            if target_drive_folder_id and target_drive_folder_id != "root"
            else "userdrive:"
        )

        rclone_proc = subprocess.Popen(
            [
                "rclone",
                "copy",
                str(upload_target_path),
                rclone_dest,
                "--rc",
                "--rc-addr=127.0.0.1:5572",
                "--rc-no-auth",
                "--drive-chunk-size=128M",
                "--transfers=4",
                "--checkers=8",
                "--quiet",
            ]
        )

        last_edit = 0.0
        last_cancel_check = 0.0
        while rclone_proc.poll() is None:
            if cancelled:
                rclone_proc.terminate()
                raise InterruptedError("Cancelled by user")

            now = time.time()
            if now - last_cancel_check >= 5.0:
                last_cancel_check = now
                if check_worker_cancelled(JOB_ID):
                    cancelled = True
                    rclone_proc.terminate()
                    raise InterruptedError("Cancelled by user")

            if now - last_edit >= 2.5:
                last_edit = now
                rc_stats = http_json("http://127.0.0.1:5572/core/stats", data={}, timeout=3)
                up_done = float(rc_stats.get("bytes") or 0)
                up_total = float(rc_stats.get("totalBytes") or file_size or 1)
                up_spd = float(rc_stats.get("speed") or 0)
                up_eta = rc_stats.get("eta")
                up_pct = (100.0 * up_done / up_total) if up_total > 0 else 0.0

                snap = sys_mon.snapshot()
                card = build_status_card(
                    job=job,
                    filename=cur_filename,
                    status_text="Uploading",
                    pct=up_pct,
                    done_bytes=up_done,
                    total_bytes=up_total,
                    speed_bps=up_spd,
                    eta_sec=up_eta,
                    engine="Rclone Drive",
                    elapsed_sec=now - task_start,
                    sys_snap=snap,
                )
                edit_status(chat_id, message_id, card, status_keyboard(JOB_ID))

            time.sleep(1.0)

        if rclone_proc.returncode != 0:
            raise RuntimeError(f"Rclone upload exited with code {rclone_proc.returncode}")

        if upload_is_dir:
            drive_link = f"https://drive.google.com/drive/folders/{target_drive_folder_id}"
        else:
            drive_link = query_drive_link(access_token, folder_id, cur_filename, is_dir=False)

        folder_url = (
            f"https://drive.google.com/drive/folders/{folder_id}"
            if folder_id and folder_id != "root"
            else "https://drive.google.com/drive/my-drive"
        )

        total_elapsed = fmt_duration(time.time() - task_start)
        uname = job.get("username") or "User"
        if not uname.startswith("@") and uname != "User":
            uname = "@" + uname

        done_text = (
            f"<blockquote><b>{sb('TRANSFER COMPLETE')}</b>\n"
            f"<code>{html.escape(cur_filename)}</code></blockquote>\n\n"
            f"┌ <b>{sb('Size')}</b>         <code>{fmt_bytes(file_size)}</code>\n"
            f"├ <b>{sb('Folder')}</b>       <code>{html.escape(folder_name)}</code>\n"
            f"├ <b>{sb('Elapsed')}</b>      <code>{total_elapsed}</code>\n"
            f"└ <b>{sb('User')}</b>         {html.escape(uname)}"
        )
        done_kb = {
            "inline_keyboard": [
                [
                    {"text": "▸  Open File", "url": drive_link, "style": "success"},
                    {"text": "Open Folder", "url": folder_url, "style": "primary"},
                ]
            ]
        }
        edit_status(chat_id, message_id, done_text, done_kb)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "completed", "drive_link": drive_link})

    except InterruptedError:
        cancel_text = (
            f"<blockquote><b>{sb('TASK CANCELLED')}</b>\n"
            f"<code>{html.escape(job.get('detectedName') or 'Task')}</code></blockquote>\n\n"
            f"└ <b>{sb('Task ID')}</b>   <code>{html.escape(JOB_ID)}</code>"
        )
        edit_status(chat_id, message_id, cancel_text)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "cancelled"})
    except Exception as e:
        err_text = (
            f"<blockquote><b>{sb('TRANSFER FAILED')}</b>\n"
            f"<code>{html.escape(job.get('detectedName') or 'Task')}</code></blockquote>\n\n"
            f"└ <b>{sb('Reason')}</b>   <code>{html.escape(str(e)[:300])}</code>"
        )
        edit_status(chat_id, message_id, err_text)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "failed", "error": str(e)})
        sys.exit(1)
    finally:
        try:
            aria_proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
