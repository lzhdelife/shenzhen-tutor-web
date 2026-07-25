import json
import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from tkinter import ttk


APP_NAME = "深圳家教剪贴板桥接器"
DEFAULT_SERVICE_URL = "https://tutor.liuzonghao.top"
BRIDGE_HEADER = "shenzhen-tutor-local-v1"
try:
    from runtime_config import BRIDGE_TOKEN
except ImportError:
    BRIDGE_TOKEN = os.getenv("SHENZHEN_TUTOR_BRIDGE_TOKEN", "")
STATUS_PENDING = "等待发送"
STATUS_SENDING = "正在发送"
STATUS_QUEUED = "等待网页导入"
STATUS_IMPORTED = "网站已导入"
STATUS_IGNORED = "非家教单已忽略"
STATUS_RETRY = "等待重试"


def app_data_dir():
    root = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "ShenzhenTutorClipboardBridge"
    root.mkdir(parents=True, exist_ok=True)
    return root


def find_repo_root():
    candidates = []
    configured = os.getenv("SHENZHEN_TUTOR_ROOT")
    if configured:
        candidates.append(Path(configured))
    candidates.extend([Path.cwd(), Path(__file__).resolve().parent.parent])
    if getattr(sys, "frozen", False):
        executable = Path(sys.executable).resolve()
        candidates.extend([executable.parent, executable.parent.parent])
    seen = set()
    for candidate in candidates:
        for path in [candidate, *candidate.parents[:3]]:
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            if (resolved / "scripts" / "start-local.js").exists():
                return resolved
    return None


class BridgeClient:
    def __init__(self, base_url, token=""):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.remote = self.base_url.startswith("https://")

    def request(self, path, method="GET", body=None, timeout=8):
        headers = {"Accept": "application/json", "X-Clipboard-Bridge": BRIDGE_HEADER}
        if self.remote and self.token:
            headers["X-Clipboard-Bridge-Token"] = self.token
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as caught:
            try:
                payload = json.loads(caught.read().decode("utf-8"))
                message = payload.get("error") or str(caught)
            except Exception:
                message = str(caught)
            raise RuntimeError(message) from caught
        except (urllib.error.URLError, TimeoutError, OSError) as caught:
            raise RuntimeError(f"官网暂不可用：{caught}") from caught

    def capture(self, record):
        return self.request("/api/clipboard/capture", "POST", {
            "captureId": record["id"],
            "capturedAt": record["time"],
            "text": record["text"],
        })

    def status(self, capture_id):
        encoded = urllib.parse.quote(capture_id, safe="")
        return self.request(f"/api/clipboard/status?captureId={encoded}")

    def health(self):
        return self.request("/api/clipboard/health" if self.remote else "/api/state", timeout=3)


class ClipboardBridgeApp:
    def __init__(self, root):
        self.root = root
        self.data_file = app_data_dir() / "records.json"
        self.records = self._load_json(self.data_file, [])
        if not isinstance(self.records, list):
            self.records = []
        self.client = BridgeClient(DEFAULT_SERVICE_URL, BRIDGE_TOKEN)
        self.collecting = True
        self.last_clipboard = self._read_clipboard()
        self.inflight = set()
        self.tasks = queue.Queue()
        self.results = queue.Queue()

        self.root.title(APP_NAME)
        self.root.geometry("820x520")
        self.root.minsize(680, 420)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self._build_ui()
        self._normalize_records()
        self._refresh_rows()

        threading.Thread(target=self._worker, daemon=True).start()
        self.tasks.put(("startup",))
        self.root.after(300, self._poll_clipboard)
        self.root.after(120, self._poll_results)
        self.root.after(1500, self._retry_pending)

    def _build_ui(self):
        self.root.configure(bg="#f4f6f8")
        style = ttk.Style()
        style.theme_use("vista")
        style.configure("Treeview", rowheight=31, font=("Microsoft YaHei UI", 10))
        style.configure("Treeview.Heading", font=("Microsoft YaHei UI", 10, "bold"))

        header = tk.Frame(self.root, bg="#ffffff", height=72)
        header.pack(fill="x")
        header.pack_propagate(False)
        tk.Label(header, text=APP_NAME, bg="#ffffff", fg="#17212b",
                 font=("Microsoft YaHei UI", 16, "bold")).pack(side="left", padx=20)
        self.connection_label = tk.Label(header, text="正在启动本地网站…", bg="#ffffff", fg="#8a5b00",
                                         font=("Microsoft YaHei UI", 10))
        self.connection_label.pack(side="left", padx=10)
        self.toggle_button = ttk.Button(header, text="暂停采集", command=self.toggle_collecting)
        self.toggle_button.pack(side="right", padx=(8, 20), ipadx=8, ipady=4)
        ttk.Button(header, text="打开发单端", command=self.open_website).pack(side="right", ipadx=8, ipady=4)

        instruction = tk.Label(
            self.root,
            text="保持本程序运行：手机复制文字 → 网站自动识别并导入",
            bg="#eef2f6",
            fg="#334155",
            font=("Microsoft YaHei UI", 10),
            anchor="w",
            padx=20,
            pady=12,
        )
        instruction.pack(fill="x")

        toolbar = tk.Frame(self.root, bg="#f4f6f8")
        toolbar.pack(fill="x", padx=16, pady=(12, 9))
        ttk.Button(toolbar, text="重试失败项", command=self.retry_all).pack(side="left")
        self.count_label = tk.Label(toolbar, text="0 条", bg="#f4f6f8", fg="#66717d", font=("Microsoft YaHei UI", 10))
        self.count_label.pack(side="right")

        frame = tk.Frame(self.root, bg="#ffffff", highlightbackground="#d6dde4", highlightthickness=1)
        frame.pack(fill="both", expand=True, padx=16, pady=(0, 10))
        self.tree = ttk.Treeview(frame, columns=("time", "status", "content", "error"), show="headings", selectmode="extended")
        for key, title in [("time", "时间"), ("status", "状态"), ("content", "剪贴板原文"), ("error", "说明")]:
            self.tree.heading(key, text=title)
        self.tree.column("time", width=90, anchor="center", stretch=False)
        self.tree.column("status", width=120, anchor="center", stretch=False)
        self.tree.column("content", width=410, anchor="w")
        self.tree.column("error", width=190, anchor="w")
        scroll = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        self.footer_label = tk.Label(self.root, text="正在监听 Windows 剪贴板。关闭网页也不会丢原文。",
                                     bg="#f4f6f8", fg="#66717d", font=("Microsoft YaHei UI", 9), anchor="w")
        self.footer_label.pack(fill="x", padx=18, pady=(0, 10))

    def _normalize_records(self):
        normalized = []
        for item in self.records:
            if not isinstance(item, dict) or not item.get("text"):
                continue
            item.setdefault("id", uuid.uuid4().hex)
            item.setdefault("time", datetime.now().isoformat(timespec="seconds"))
            item.setdefault("status", STATUS_PENDING)
            item.setdefault("attempts", 0)
            item.setdefault("nextRetryAt", 0)
            item.setdefault("error", "")
            if item["status"] in (STATUS_IMPORTED, STATUS_IGNORED):
                continue
            if item["status"] == STATUS_SENDING:
                item["status"] = STATUS_RETRY
            normalized.append(item)
        self.records = normalized
        self._save_records()

    def _read_clipboard(self):
        try:
            value = self.root.clipboard_get()
            return value if isinstance(value, str) else ""
        except tk.TclError:
            return ""

    def _poll_clipboard(self):
        current = self._read_clipboard()
        if self.collecting and current and current != self.last_clipboard:
            self.last_clipboard = current
            self._add_record(current)
        elif current:
            self.last_clipboard = current
        self.root.after(300, self._poll_clipboard)

    def _add_record(self, text):
        record = {
            "id": uuid.uuid4().hex,
            "time": datetime.now().isoformat(timespec="seconds"),
            "text": text,
            "status": STATUS_PENDING,
            "attempts": 0,
            "nextRetryAt": 0,
            "error": "",
        }
        self.records.append(record)
        self._save_records()
        self._refresh_rows()
        self.tree.yview_moveto(1)
        self._send_record(record)

    def _send_record(self, record):
        if record["id"] in self.inflight:
            return
        self.inflight.add(record["id"])
        record["status"] = STATUS_SENDING
        record["error"] = ""
        self._save_records()
        self._refresh_rows()
        self.tasks.put(("capture", record["id"]))

    def _worker(self):
        while True:
            task = self.tasks.get()
            kind = task[0]
            try:
                if kind == "startup":
                    self._ensure_local_service()
                    self.results.put(("startup_ok",))
                elif kind == "capture":
                    record = self._record(task[1])
                    if record:
                        self.results.put(("capture_ok", record["id"], self.client.capture(record)))
                elif kind == "status":
                    self.results.put(("status_ok", task[1], self.client.status(task[1])))
            except Exception as caught:
                self.results.put((f"{kind}_error", task[1] if len(task) > 1 else None, str(caught)))
            finally:
                self.tasks.task_done()

    def _ensure_local_service(self):
        try:
            self.client.health()
            return
        except Exception:
            if self.client.remote:
                raise RuntimeError("官网桥接授权无效或暂时不可用，请联系平台管理员")
        repo = find_repo_root()
        if not repo:
            raise RuntimeError("未找到网站项目，请先运行 npm start")
        flags = 0x08000000 if os.name == "nt" else 0
        subprocess.Popen(["node", "scripts/start-local.js"], cwd=repo, creationflags=flags,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 12
        while time.time() < deadline:
            time.sleep(0.4)
            try:
                self.client.health()
                return
            except Exception:
                continue
        raise RuntimeError("本地网站启动超时，请检查 Node.js 和项目配置")

    def _poll_results(self):
        while True:
            try:
                result = self.results.get_nowait()
            except queue.Empty:
                break
            kind = result[0]
            record_id = result[1] if len(result) > 1 else None
            if record_id:
                self.inflight.discard(record_id)
            if kind == "startup_ok":
                self.connection_label.configure(text="本地网站已连接", fg="#178653")
                self.footer_label.configure(text="已开始监听。手机复制后，网页会自动识别并导入。")
                self.open_website()
                self.retry_all(silent=True)
            elif kind == "startup_error":
                self.connection_label.configure(text="本地网站未连接", fg="#b3261e")
                self.footer_label.configure(text=result[2])
            elif kind == "capture_ok":
                record = self._record(record_id)
                if record:
                    status = result[2].get("status")
                    if status in ("completed", "ignored"):
                        self._remove_record(record_id)
                    else:
                        record["status"] = STATUS_QUEUED
                        record["error"] = "已送达网站，等待发单端处理"
                        record["nextRetryAt"] = 0
            elif kind == "status_ok":
                record = self._record(record_id)
                if record:
                    status = result[2].get("status")
                    if status in ("completed", "ignored"):
                        self._remove_record(record_id)
                    elif status == "unknown":
                        record["status"] = STATUS_RETRY
                        record["error"] = "网站回执已过期，准备重新确认"
                        record["nextRetryAt"] = 0
            elif kind in ("capture_error", "status_error"):
                record = self._record(record_id)
                if record and kind == "capture_error":
                    record["attempts"] = int(record.get("attempts", 0)) + 1
                    record["status"] = STATUS_RETRY
                    record["error"] = result[2]
                    record["nextRetryAt"] = time.time() + min(60, 2 ** min(record["attempts"], 6))
            self._save_records()
            self._refresh_rows()
        self.root.after(120, self._poll_results)

    def _retry_pending(self):
        now = time.time()
        for record in self.records:
            if record["status"] in (STATUS_PENDING, STATUS_RETRY) and float(record.get("nextRetryAt", 0)) <= now:
                self._send_record(record)
            elif record["status"] == STATUS_QUEUED and record["id"] not in self.inflight:
                self.inflight.add(record["id"])
                self.tasks.put(("status", record["id"]))
        self.root.after(5000, self._retry_pending)

    def retry_all(self, silent=False):
        count = 0
        for record in self.records:
            if record["status"] in (STATUS_PENDING, STATUS_RETRY):
                record["nextRetryAt"] = 0
                self._send_record(record)
                count += 1
        if not silent:
            self.footer_label.configure(text=f"已重试 {count} 条。" if count else "没有需要重试的原文。")

    def toggle_collecting(self):
        self.collecting = not self.collecting
        self.toggle_button.configure(text="暂停采集" if self.collecting else "继续采集")
        self.footer_label.configure(text="正在监听 Windows 剪贴板。" if self.collecting else "采集已暂停，已保存的原文仍会继续发送。")

    def open_website(self):
        webbrowser.open(f"{DEFAULT_SERVICE_URL}/?view=agency")

    def _record(self, record_id):
        return next((record for record in self.records if record.get("id") == record_id), None)

    def _remove_record(self, record_id):
        self.records = [record for record in self.records if record.get("id") != record_id]

    def _refresh_rows(self):
        self.tree.delete(*self.tree.get_children())
        for record in self.records:
            preview = record["text"].replace("\r", " ").replace("\n", "  ")
            self.tree.insert("", "end", iid=record["id"], values=(
                record["time"][11:19], record["status"], preview[:180], record.get("error", "")[:120]
            ))
        self.count_label.configure(text=f"{len(self.records)} 条")

    def _save_records(self):
        temp = self.data_file.with_suffix(".tmp")
        temp.write_text(json.dumps(self.records, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.data_file)

    @staticmethod
    def _load_json(path, fallback):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return fallback

    def on_close(self):
        self.root.destroy()


if __name__ == "__main__":
    window = tk.Tk()
    ClipboardBridgeApp(window)
    window.mainloop()
