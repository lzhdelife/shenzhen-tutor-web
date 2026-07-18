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
from tkinter import messagebox, ttk


APP_NAME = "深圳家教剪贴板桥接器"
DEFAULT_SERVICE_URL = "http://127.0.0.1:8787"
BRIDGE_HEADER = "shenzhen-tutor-local-v1"
STATUS_PENDING = "等待发送"
STATUS_SENDING = "正在发送"
STATUS_QUEUED = "等待网页导入"
STATUS_IMPORTED = "网站已导入"
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
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")

    def request(self, path, method="GET", body=None, timeout=8):
        headers = {"Accept": "application/json", "X-Clipboard-Bridge": BRIDGE_HEADER}
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
            raise RuntimeError(f"本地网站暂不可用：{caught}") from caught

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
        return self.request("/api/state", timeout=3)


class ClipboardBridgeApp:
    def __init__(self, root):
        self.root = root
        self.data_file = app_data_dir() / "records.json"
        self.settings_file = app_data_dir() / "settings.json"
        self.settings = self._load_json(self.settings_file, {})
        self.records = self._load_json(self.data_file, [])
        if not isinstance(self.records, list):
            self.records = []
        self.service_url = tk.StringVar(value=self.settings.get("serviceUrl", DEFAULT_SERVICE_URL))
        self.open_site_on_start = tk.BooleanVar(value=self.settings.get("openSiteOnStart", True))
        self.client = BridgeClient(self.service_url.get())
        self.collecting = True
        self.last_clipboard = self._read_clipboard()
        self.suppressed_text = None
        self.inflight = set()
        self.tasks = queue.Queue()
        self.results = queue.Queue()

        self.root.title(APP_NAME)
        self.root.geometry("1080x650")
        self.root.minsize(760, 480)
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

        options = tk.Frame(self.root, bg="#eef2f6", height=50)
        options.pack(fill="x")
        options.pack_propagate(False)
        tk.Label(options, text="本地网站", bg="#eef2f6", font=("Microsoft YaHei UI", 9, "bold")).pack(side="left", padx=(20, 7))
        ttk.Entry(options, textvariable=self.service_url, width=34).pack(side="left")
        ttk.Checkbutton(options, text="启动时自动打开发单端", variable=self.open_site_on_start).pack(side="left", padx=14)
        tk.Label(options, text="打开程序后即可在手机复制，原文会自动进入网站", bg="#eef2f6", fg="#66717d",
                 font=("Microsoft YaHei UI", 9)).pack(side="right", padx=20)

        toolbar = tk.Frame(self.root, bg="#f4f6f8")
        toolbar.pack(fill="x", padx=16, pady=(12, 9))
        ttk.Button(toolbar, text="立即重试", command=self.retry_all).pack(side="left", padx=(0, 7))
        ttk.Button(toolbar, text="复制全部", command=self.copy_all).pack(side="left", padx=(0, 7))
        ttk.Button(toolbar, text="删除选中", command=self.delete_selected).pack(side="left")
        self.count_label = tk.Label(toolbar, text="0 条", bg="#f4f6f8", fg="#66717d", font=("Microsoft YaHei UI", 10))
        self.count_label.pack(side="right")

        frame = tk.Frame(self.root, bg="#ffffff", highlightbackground="#d6dde4", highlightthickness=1)
        frame.pack(fill="both", expand=True, padx=16, pady=(0, 10))
        self.tree = ttk.Treeview(frame, columns=("time", "status", "content", "error"), show="headings", selectmode="extended")
        for key, title in [("time", "时间"), ("status", "状态"), ("content", "剪贴板原文"), ("error", "说明")]:
            self.tree.heading(key, text=title)
        self.tree.column("time", width=90, anchor="center", stretch=False)
        self.tree.column("status", width=120, anchor="center", stretch=False)
        self.tree.column("content", width=560, anchor="w")
        self.tree.column("error", width=260, anchor="w")
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
            if current != self.suppressed_text:
                self._add_record(current)
            self.suppressed_text = None
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
            pass
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
                if self.open_site_on_start.get():
                    self.open_website()
                self.retry_all(silent=True)
            elif kind == "startup_error":
                self.connection_label.configure(text="本地网站未连接", fg="#b3261e")
                self.footer_label.configure(text=result[2])
            elif kind == "capture_ok":
                record = self._record(record_id)
                if record:
                    status = result[2].get("status")
                    record["status"] = STATUS_IMPORTED if status == "completed" else STATUS_QUEUED
                    record["error"] = "" if status == "completed" else "已送达网站，等待发单端处理"
                    record["nextRetryAt"] = 0
            elif kind == "status_ok":
                record = self._record(record_id)
                if record and result[2].get("status") == "completed":
                    record["status"] = STATUS_IMPORTED
                    record["error"] = "自动解析和导入已完成"
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
        self.client = BridgeClient(self.service_url.get().strip() or DEFAULT_SERVICE_URL)
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
        base = (self.service_url.get().strip() or DEFAULT_SERVICE_URL).replace("127.0.0.1", "localhost")
        webbrowser.open(f"{base}/?view=agency")

    def copy_all(self):
        if not self.records:
            return
        combined = "\n\n".join(record["text"] for record in self.records)
        self.suppressed_text = combined
        self.last_clipboard = combined
        self.root.clipboard_clear()
        self.root.clipboard_append(combined)
        self.root.update()

    def delete_selected(self):
        selected = set(self.tree.selection())
        if not selected:
            return
        if not messagebox.askyesno(APP_NAME, f"删除选中的 {len(selected)} 条本地记录吗？"):
            return
        self.records = [record for record in self.records if record["id"] not in selected]
        self._save_records()
        self._refresh_rows()

    def _record(self, record_id):
        return next((record for record in self.records if record.get("id") == record_id), None)

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
        self.settings_file.write_text(json.dumps({
            "serviceUrl": self.service_url.get().strip() or DEFAULT_SERVICE_URL,
            "openSiteOnStart": self.open_site_on_start.get(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        self.root.destroy()


if __name__ == "__main__":
    window = tk.Tk()
    ClipboardBridgeApp(window)
    window.mainloop()
