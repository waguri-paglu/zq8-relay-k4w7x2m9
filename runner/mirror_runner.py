#!/usr/bin/env python3
"""
On-Demand Gigabit Mirror Runner for GitHub Actions.
- Normal Roboto (native Telegram UI text) for prose, labels, engines, and folder names
- Monospace (<code> / <pre>) for filenames, numeric telemetry, progress bars, and system stats
- Colored InlineKeyboardButtons (style: "primary" | "danger" | "success")
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


def fmt_sys_bytes(num: float) -> str:
    if num <= 0:
        return "0.00B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(num) < 1024.0:
            return f"{num:.2f}{unit}"
        num /= 1024.0
    return f"{num:.2f}PB"


def fmt_duration(seconds: float) -> str:
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
    run_url = (
        f"https://github.com/waguri-paglu/zq8-relay-k4w7x2m9/actions/runs/{GITHUB_RUN_ID}"
        if GITHUB_RUN_ID
        else "https://github.com/waguri-paglu/zq8-relay-k4w7x2m9/actions"
    )

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
        f"├ By : {html.escape(uname)}",
        f"├ UserID : <code>[{html.escape(str(uid))}]</code>",
        f"├ Elapsed : <code>{fmt_duration(elapsed_sec)}</code>",
        f"├ Size : <code>{total_str}</code>",
        f"├ Processed : <code>{done_str}</code>",
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
    payload = {
        "jsonrpc": "2.0",
        "id": "1",
        "method": method,
        "params": params or [],
    }
    return http_json("http://127.0.0.1:6800/jsonrpc", data=payload, timeout=5)


def sync_worker_state(job_id: str, last_card: str = None):
    payload = {"job_id": job_id}
    if last_card:
        payload["last_card"] = last_card
    res = worker_call("/internal/job-status", payload)
    cancelled = bool(res.get("cancelled"))
    msg_id = str(res.get("messageId") or "") if "messageId" in res else None
    return cancelled, msg_id


def finish_status(chat_id, message_id, text: str, reply_markup: dict = None):
    if message_id:
        edit_status(chat_id, message_id, text, reply_markup)
    elif chat_id:
        send_message(chat_id, text, reply_markup)


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
        last_edit = 0.0
        cur_filename = custom_name or job.get("detectedName") or "Downloading..."
        total_len = 0
        done_len = 0

        while True:
            if cancelled:
                aria2_rpc("aria2.forceRemove", [gid])
                raise InterruptedError("Cancelled by user")

            now = time.time()
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
                    status_text="Download..",
                    pct=pct,
                    done_bytes=done_len,
                    total_bytes=total_len,
                    speed_bps=dl_spd,
                    eta_sec=eta,
                    engine="Aria2c v1.37.0",
                    elapsed_sec=now - task_start,
                    sys_snap=snap,
                )
                is_cancelled, synced_msg_id = sync_worker_state(JOB_ID, last_card=card)
                if synced_msg_id is not None:
                    message_id = synced_msg_id
                if is_cancelled:
                    cancelled = True
                    aria2_rpc("aria2.forceRemove", [gid])
                    raise InterruptedError("Cancelled by user")
                if message_id:
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
                    f"<blockquote><b>Workspace Notice</b>\n\n"
                    f"Remaining disk (<code>{fmt_bytes(du_free)}</code>) is tight for archive extraction. Uploading original file directly.</blockquote>",
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
            is_cancelled, synced_msg_id = sync_worker_state(JOB_ID, last_card=card)
            if synced_msg_id is not None:
                message_id = synced_msg_id
            if is_cancelled:
                raise InterruptedError("Cancelled by user")
            if message_id:
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
                        f"<blockquote><b>Extraction Notice</b>\n\nUnsupported archive format. Uploading original file instead.</blockquote>",
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
            is_cancelled, synced_msg_id = sync_worker_state(JOB_ID, last_card=card)
            if synced_msg_id is not None:
                message_id = synced_msg_id
            if is_cancelled:
                raise InterruptedError("Cancelled by user")
            if message_id:
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
        while rclone_proc.poll() is None:
            if cancelled:
                rclone_proc.terminate()
                raise InterruptedError("Cancelled by user")

            now = time.time()
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
                    status_text="Uploading..",
                    pct=up_pct,
                    done_bytes=up_done,
                    total_bytes=up_total,
                    speed_bps=up_spd,
                    eta_sec=up_eta,
                    engine="Rclone Drive",
                    elapsed_sec=now - task_start,
                    sys_snap=snap,
                )
                is_cancelled, synced_msg_id = sync_worker_state(JOB_ID, last_card=card)
                if synced_msg_id is not None:
                    message_id = synced_msg_id
                if is_cancelled:
                    cancelled = True
                    rclone_proc.terminate()
                    raise InterruptedError("Cancelled by user")
                if message_id:
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
            f"<blockquote><b>Transfer Complete</b>\n\n"
            f"<code>{html.escape(cur_filename)}</code></blockquote>\n\n"
            f"Size  ·  <code>{fmt_bytes(file_size)}</code>\n\n"
            f"Folder  ·  {html.escape(folder_name)}\n\n"
            f"Elapsed  ·  <code>{total_elapsed}</code>\n\n"
            f"User  ·  {html.escape(uname)}"
        )
        done_kb = {
            "inline_keyboard": [
                [
                    {"text": "▸  Open File", "url": drive_link, "style": "success"},
                    {"text": "Open Folder", "url": folder_url, "style": "primary"},
                ]
            ]
        }
        _, synced_msg_id = sync_worker_state(JOB_ID)
        if synced_msg_id is not None:
            message_id = synced_msg_id
        finish_status(chat_id, message_id, done_text, done_kb)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "completed", "drive_link": drive_link})

    except InterruptedError:
        cancel_text = (
            f"<blockquote><b>Task Cancelled</b>\n\n"
            f"<code>{html.escape(job.get('detectedName') or 'Task')}</code></blockquote>\n\n"
            f"Task ID  ·  <code>{html.escape(JOB_ID)}</code>"
        )
        _, synced_msg_id = sync_worker_state(JOB_ID)
        if synced_msg_id is not None:
            message_id = synced_msg_id
        finish_status(chat_id, message_id, cancel_text)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "cancelled"})
    except Exception as e:
        err_text = (
            f"<blockquote><b>Transfer Failed</b>\n\n"
            f"<code>{html.escape(job.get('detectedName') or 'Task')}</code></blockquote>\n\n"
            f"Reason  ·  <code>{html.escape(str(e)[:300])}</code>"
        )
        _, synced_msg_id = sync_worker_state(JOB_ID)
        if synced_msg_id is not None:
            message_id = synced_msg_id
        finish_status(chat_id, message_id, err_text)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "failed", "error": str(e)})
        sys.exit(1)
    finally:
        try:
            aria_proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
