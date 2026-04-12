from __future__ import annotations

import base64
import io
import json
import logging
import os
import queue
import re
import socket
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import RLock
from typing import Any

from flask import Flask, jsonify, render_template, request, send_from_directory
from flask_socketio import SocketIO
from werkzeug.utils import secure_filename

PREFERRED_ASYNC_MODE = os.getenv("SOCKETIO_ASYNC_MODE", "").strip().lower()

if PREFERRED_ASYNC_MODE == "threading":
    ASYNC_MODE = "threading"
elif os.name == "nt":
    # Windows 下 eventlet 经常导致 Flask-SocketIO 请求挂住，
    # 默认退回 threading，稳定性更高。
    ASYNC_MODE = "threading"
else:
    try:
        import eventlet  # noqa: F401
    except Exception:
        ASYNC_MODE = "threading"
    else:
        ASYNC_MODE = "eventlet"

try:
    import serial
    from serial.tools import list_ports
except Exception:
    serial = None
    list_ports = None

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as exc:  # pragma: no cover
    raise RuntimeError("缺少 Pillow，请先安装 requirements.txt") from exc

try:
    import qrcode
except Exception as exc:  # pragma: no cover
    raise RuntimeError("缺少 qrcode，请先安装 requirements.txt") from exc


BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "templates"
RUNTIME_DIR = BASE_DIR / "runtime"
UPLOAD_DIR = RUNTIME_DIR / "uploads"
POSTER_DIR = RUNTIME_DIR / "posters"

for folder in (RUNTIME_DIR, UPLOAD_DIR, POSTER_DIR):
    folder.mkdir(parents=True, exist_ok=True)


HOST = "0.0.0.0"
PORT = 5000
SERIAL_BAUD = 115200
SERIAL_RETRY_SEC = 3
GUIDE_DURATION_SEC = 86
EXPERIENCE_DURATION_SEC = 120
TRANSITION_DURATION_SEC = 18
DEFAULT_WEIGHT_CHEST = 0.6
DEFAULT_WEIGHT_WAIST = 0.4
DEFAULT_THRESHOLD = 1800.0
PREVIEW_BLEND_DEADBAND = 0.05
PREVIEW_BLEND_THRESHOLD_RATIO = 0.25
PREVIEW_BLEND_SMOOTHING = 0.08
PUBLIC_URL = os.getenv("PUBLIC_URL", f"http://localhost:{PORT}").rstrip("/")
START_COMMAND = os.getenv("ARDUINO_START_COMMAND", "START")
RESET_COMMAND = os.getenv("ARDUINO_RESET_COMMAND", "RESET")

ALLOWED_UPLOAD_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
SERIAL_LINE_PATTERN = re.compile(r"([A-Za-z0-9_]+):([-+]?\d+(?:\.\d+)?)")
DEFAULT_STATE_PAYLOAD_FIELDS = ("mode", "session_id", "blend", "serial_connected", "serial_port")


logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("raina.flask")

app = Flask(__name__, template_folder=str(TEMPLATE_DIR))
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "raina-dev-secret")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode=ASYNC_MODE)


@dataclass
class SensorSnapshot:
    s1: int = 0
    s2: int = 0
    s3: int = 0
    s4: int = 0
    raw_blend: float = 0.0
    blend: float = 0.0
    source: str = "idle"
    raw_line: str = ""
    updated_at: float = field(default_factory=time.time)


@dataclass
class SessionBundle:
    session_id: str
    created_at: float
    locked: bool = False
    xray_filename: str | None = None
    spine_points: list[dict[str, Any]] = field(default_factory=list)
    analysis_source: str = "fallback"
    poster_name: str | None = None
    poster_prompt: str | None = None


class RuntimeState:
    def __init__(self) -> None:
        self.lock = RLock()
        self.mode = "IDLE"
        self.weight_chest = DEFAULT_WEIGHT_CHEST
        self.weight_waist = DEFAULT_WEIGHT_WAIST
        self.threshold = DEFAULT_THRESHOLD
        self.sensor = SensorSnapshot()
        self.serial_connected = False
        self.serial_port = ""
        self.debug_override = False
        self.session = self._new_session()

    def _new_session(self) -> SessionBundle:
        return SessionBundle(session_id=uuid.uuid4().hex[:12], created_at=time.time())

    def reset_for_new_session(self) -> SessionBundle:
        self.mode = "IDLE"
        self.sensor = SensorSnapshot()
        self.debug_override = False
        self.session = self._new_session()
        return self.session

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "mode": self.mode,
                "session_id": self.session.session_id,
                "session_locked": self.session.locked,
                "weight_chest": self.weight_chest,
                "weight_waist": self.weight_waist,
                "threshold": self.threshold,
                "serial_connected": self.serial_connected,
                "serial_port": self.serial_port,
                "sensor": asdict(self.sensor),
                "upload_url": build_upload_url(self.session.session_id),
                "upload_qr_data_url": make_qr_data_url(build_upload_url(self.session.session_id)),
                "poster_name": self.session.poster_name,
                "poster_url": build_poster_url(self.session.poster_name),
                "view_url": build_view_url(self.session.poster_name),
                "analysis_source": self.session.analysis_source,
            }


state = RuntimeState()


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def guess_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def build_upload_url(session_id: str) -> str:
    return f"{PUBLIC_URL}/upload?session={session_id}"


def build_poster_url(name: str | None) -> str | None:
    if not name:
        return None
    return f"{PUBLIC_URL}/poster/{name}"


def build_view_url(name: str | None) -> str | None:
    if not name:
        return None
    return f"{PUBLIC_URL}/view/{name}"


def make_qr_data_url(text: str) -> str:
    qr = qrcode.QRCode(border=1, box_size=8)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def emit_state_change(mode: str | None = None, room: str | None = None, **extra: Any) -> None:
    payload = state.snapshot()
    if mode is not None:
        payload["mode"] = mode
    payload.update(extra)
    payload["blend"] = payload["sensor"]["blend"]
    slim = {key: payload.get(key) for key in DEFAULT_STATE_PAYLOAD_FIELDS}
    slim.update(extra)
    if "blend" not in slim:
        slim["blend"] = payload["sensor"]["blend"]
    socketio.emit("state_change", slim, to=room)


def emit_session_update(room: str | None = None) -> None:
    snapshot = state.snapshot()
    socketio.emit(
        "session_update",
        {
            "session_id": snapshot["session_id"],
            "upload_url": snapshot["upload_url"],
            "upload_qr_data_url": snapshot["upload_qr_data_url"],
            "poster_url": snapshot["poster_url"],
            "view_url": snapshot["view_url"],
        },
        to=room,
    )


def emit_sensor(snapshot: SensorSnapshot, room: str | None = None) -> None:
    socketio.emit(
        "sensor_data",
        {
            "s1": snapshot.s1,
            "s2": snapshot.s2,
            "s3": snapshot.s3,
            "s4": snapshot.s4,
            "blend": snapshot.blend,
            "raw_blend": snapshot.raw_blend,
            "source": snapshot.source,
        },
        to=room,
    )


def allowed_upload(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_UPLOAD_EXTENSIONS


def generate_fallback_spine_points() -> list[dict[str, Any]]:
    labels = [
        "C7", "T1", "T3", "T5", "T7", "T9", "T11",
        "L1", "L2", "L3", "L4", "L5", "S1",
    ]
    points: list[dict[str, Any]] = []
    total = len(labels) - 1
    for idx, label in enumerate(labels):
        t = idx / total if total else 0.0
        y = 0.92 - t * 1.84
        x = 0.14 * (1.0 - abs(2.0 * t - 1.0))
        if idx >= len(labels) // 2:
            x *= -0.5
        points.append({"label": label, "x": round(x, 4), "y": round(y, 4)})
    return points


def analyze_xray_with_optional_ai(image_path: Path) -> tuple[list[dict[str, Any]], str]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return generate_fallback_spine_points(), "fallback"

    try:
        from google import genai  # type: ignore
    except Exception:
        logger.warning("检测到 GEMINI_API_KEY，但 google-genai 未安装，改用回退坐标。")
        return generate_fallback_spine_points(), "fallback"

    prompt = (
        "你是一名脊柱影像分析助手。请沿脊柱中线从 C7 到 S1 提取 13-19 个关键点，"
        '返回 JSON，格式必须是 {"points":[{"label":"C7","x":0.0,"y":0.9}]}. '
        "x 和 y 都要归一化到 -1 到 1。不要返回 markdown 代码块。"
    )

    try:
        client = genai.Client(api_key=api_key)
        uploaded = client.files.upload(file=str(image_path))
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[prompt, uploaded],
        )
        text = getattr(response, "text", "") or ""
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise ValueError("Gemini 未返回可解析 JSON")
        payload = json.loads(match.group(0))
        points = payload.get("points") or []
        if not points:
            raise ValueError("Gemini 返回 points 为空")
        normalized: list[dict[str, Any]] = []
        for item in points:
            normalized.append(
                {
                    "label": str(item.get("label", "")) or f"P{len(normalized) + 1}",
                    "x": round(float(item["x"]), 4),
                    "y": round(float(item["y"]), 4),
                }
            )
        return normalized, "gemini"
    except Exception as exc:
        logger.exception("Gemini 分析失败，改用回退坐标: %s", exc)
        return generate_fallback_spine_points(), "fallback"


def render_poster(
    poster_path: Path,
    session_bundle: SessionBundle,
    blend_final: float,
    breath_count: int,
    avg_intensity: float,
) -> None:
    width, height = 1024, 1024
    img = Image.new("RGB", (width, height), "#0a0f1d")
    draw = ImageDraw.Draw(img)

    for y in range(height):
        ratio = y / max(1, height - 1)
        r = int(10 + ratio * 30)
        g = int(15 + ratio * 40)
        b = int(29 + ratio * 80)
        draw.line((0, y, width, y), fill=(r, g, b))

    center_x = width // 2
    center_y = height // 2
    radius = int(150 + clamp(blend_final, 0.0, 1.0) * 170)
    glow_color = (215, 191, 128)
    for offset in range(14, 0, -1):
        alpha_radius = radius + offset * 22
        alpha = max(12, 120 - offset * 7)
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        overlay_draw = ImageDraw.Draw(overlay)
        overlay_draw.ellipse(
            (
                center_x - alpha_radius,
                center_y - alpha_radius,
                center_x + alpha_radius,
                center_y + alpha_radius,
            ),
            fill=(glow_color[0], glow_color[1], glow_color[2], alpha),
        )
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    draw = ImageDraw.Draw(img)
    title = "RAINA"
    subtitle = f"session {session_bundle.session_id}"
    metrics = [
        f"blend_final   {blend_final:.3f}",
        f"breath_count  {breath_count}",
        f"avg_intensity {avg_intensity:.3f}",
        f"spine_points  {len(session_bundle.spine_points)}",
    ]

    font = ImageFont.load_default()
    draw.text((76, 72), title, fill="#f4e6b7", font=font)
    draw.text((76, 100), subtitle, fill="#9db0d7", font=font)

    text_y = height - 200
    for line in metrics:
        draw.text((76, text_y), line, fill="#dfe7ff", font=font)
        text_y += 24

    if session_bundle.spine_points:
        scaled: list[tuple[int, int]] = []
        for item in session_bundle.spine_points:
            px = int(width * 0.5 + float(item["x"]) * 180)
            py = int(height * 0.52 - float(item["y"]) * 260)
            scaled.append((px, py))
        if len(scaled) >= 2:
            draw.line(scaled, fill="#f1c769", width=8)
        for px, py in scaled:
            draw.ellipse((px - 7, py - 7, px + 7, py + 7), fill="#fff2ca")

    img.save(poster_path, format="PNG")


def parse_serial_payload(line: str) -> dict[str, float]:
    payload: dict[str, float] = {}
    for key, value in SERIAL_LINE_PATTERN.findall(line):
        try:
            payload[key.upper()] = float(value)
        except ValueError:
            continue
    return payload


def compute_blend_from_payload(payload: dict[str, float]) -> tuple[float, float]:
    with state.lock:
        use_arduino_blend = state.mode == "EXPERIENCE" and "B" in payload
        if use_arduino_blend:
            raw = clamp(payload["B"] / 255.0, 0.0, 1.0)
            return raw, raw

        chest = payload.get("S1", 0.0) - payload.get("S2", 0.0)
        waist = payload.get("S4", 0.0) - payload.get("S3", 0.0)
        raw_score = chest * state.weight_chest + waist * state.weight_waist
        preview_threshold = max(state.threshold * PREVIEW_BLEND_THRESHOLD_RATIO, 1.0)
        normalized = clamp(raw_score / preview_threshold, 0.0, 1.0)
        if normalized <= PREVIEW_BLEND_DEADBAND:
            normalized = 0.0
        else:
            normalized = (normalized - PREVIEW_BLEND_DEADBAND) / (1.0 - PREVIEW_BLEND_DEADBAND)

        previous_blend = state.sensor.blend
        if normalized <= previous_blend:
            smoothed = previous_blend
        else:
            smoothed = previous_blend + (normalized - previous_blend) * PREVIEW_BLEND_SMOOTHING
        if smoothed < 0.003:
            smoothed = 0.0
        return raw_score, clamp(smoothed, 0.0, 1.0)


class SerialBridge:
    def __init__(self) -> None:
        self.command_queue: queue.Queue[str] = queue.Queue()

    def start(self) -> None:
        socketio.start_background_task(self.worker)

    def enqueue(self, command: str) -> None:
        if command:
            self.command_queue.put(command.strip())

    def detect_port(self) -> str | None:
        if list_ports is None:
            return None

        preferred = os.getenv("ARDUINO_PORT")
        if preferred:
            return preferred

        for port in list_ports.comports():
            summary = f"{port.device} {port.description} {port.hwid}".lower()
            if any(token in summary for token in ("arduino", "ch340", "usb serial", "wch")):
                return port.device
        return None

    def mark_disconnected(self) -> None:
        with state.lock:
            state.serial_connected = False
            state.serial_port = ""

    def worker(self) -> None:
        if serial is None:
            logger.warning("pyserial 未安装，串口桥接不会启动。")
            return

        while True:
            port_name = self.detect_port()
            if not port_name:
                self.mark_disconnected()
                logger.warning("未检测到 Arduino 串口，%s 秒后重试。", SERIAL_RETRY_SEC)
                socketio.sleep(SERIAL_RETRY_SEC)
                continue

            try:
                logger.info("尝试连接 Arduino 串口：%s", port_name)
                with serial.Serial(port_name, SERIAL_BAUD, timeout=0.1) as ser:
                    with state.lock:
                        state.serial_connected = True
                        state.serial_port = port_name
                    self.sync_runtime_to_arduino()

                    while True:
                        self.flush_commands(ser)
                        raw = ser.readline()
                        if not raw:
                            socketio.sleep(0.01)
                            continue
                        line = raw.decode("utf-8", errors="ignore").strip()
                        if line:
                            self.handle_line(line)
            except Exception as exc:
                logger.warning("串口连接中断：%s", exc)
                self.mark_disconnected()
                socketio.sleep(SERIAL_RETRY_SEC)

    def flush_commands(self, ser: Any) -> None:
        while True:
            try:
                command = self.command_queue.get_nowait()
            except queue.Empty:
                return
            logger.info("→ Arduino: %s", command)
            ser.write((command + "\n").encode("utf-8"))

    def handle_line(self, line: str) -> None:
        payload = parse_serial_payload(line)
        if not payload:
            logger.info("Arduino: %s", line)
            return

        raw_blend, blend = compute_blend_from_payload(payload)
        snapshot = SensorSnapshot(
            s1=int(payload.get("S1", 0.0)),
            s2=int(payload.get("S2", 0.0)),
            s3=int(payload.get("S3", 0.0)),
            s4=int(payload.get("S4", 0.0)),
            raw_blend=raw_blend,
            blend=blend,
            source="serial",
            raw_line=line,
            updated_at=time.time(),
        )
        with state.lock:
            if state.debug_override:
                return
            state.sensor = snapshot
        emit_sensor(snapshot)

    def sync_runtime_to_arduino(self) -> None:
        with state.lock:
            weight_command = f"WEIGHT:{state.weight_chest:.3f},{state.weight_waist:.3f}"
            threshold_command = f"THRESHOLD:{state.threshold:.1f}"
        self.enqueue(weight_command)
        self.enqueue(threshold_command)


serial_bridge = SerialBridge()


def sync_arduino_for_mode(mode: str) -> None:
    if mode == "EXPERIENCE":
        logger.info("进入 EXPERIENCE，启动 Arduino 呼吸节奏")
        serial_bridge.enqueue(START_COMMAND)
        return
    if mode in {"TRANSITION", "WAITING", "IDLE"}:
        logger.info("离开体验阶段，停止 Arduino 呼吸节奏")
        serial_bridge.enqueue(RESET_COMMAND)


def schedule_state_change(delay_sec: float, expected_mode: str, next_mode: str) -> None:
    session_id = state.session.session_id

    def _task() -> None:
        socketio.sleep(delay_sec)
        with state.lock:
            if state.session.session_id != session_id or state.mode != expected_mode:
                return
            state.mode = next_mode
        sync_arduino_for_mode(next_mode)
        emit_state_change(mode=next_mode)

    socketio.start_background_task(_task)


def start_guide_flow() -> dict[str, Any]:
    with state.lock:
        if state.mode != "IDLE":
            return state.snapshot()
        state.mode = "GUIDE"
        state.session.locked = True
        state.debug_override = False
        snapshot = state.snapshot()

    emit_state_change(mode="START_GUIDE")
    schedule_state_change(GUIDE_DURATION_SEC, "GUIDE", "EXPERIENCE")
    schedule_state_change(GUIDE_DURATION_SEC + EXPERIENCE_DURATION_SEC, "EXPERIENCE", "TRANSITION")
    schedule_state_change(
        GUIDE_DURATION_SEC + EXPERIENCE_DURATION_SEC + TRANSITION_DURATION_SEC,
        "TRANSITION",
        "WAITING",
    )
    return snapshot


def reset_system() -> dict[str, Any]:
    with state.lock:
        state.reset_for_new_session()
        snapshot = state.snapshot()
    serial_bridge.enqueue(RESET_COMMAND)
    socketio.emit("reset", {"session_id": snapshot["session_id"]})
    emit_state_change(mode="IDLE")
    emit_session_update()
    return snapshot


@app.get("/")
def root() -> Any:
    return jsonify(
        {
            "name": "RAINA Flask Backend",
            "local_ip": guess_local_ip(),
            "status": f"{PUBLIC_URL}/status",
            "upload": build_upload_url(state.session.session_id),
        }
    )


@app.get("/health")
def health() -> Any:
    return jsonify({"ok": True, "async_mode": ASYNC_MODE})


@app.get("/status")
def status() -> Any:
    return jsonify(state.snapshot())


@app.get("/upload")
def upload_page() -> Any:
    session_id = request.args.get("session", "").strip()
    snapshot = state.snapshot()
    valid = session_id == snapshot["session_id"]
    return render_template(
        "upload.html",
        session_id=snapshot["session_id"],
        valid_session=valid,
        locked=snapshot["session_locked"],
        upload_url=build_upload_url(snapshot["session_id"]),
    )


@app.post("/upload")
def upload_xray() -> Any:
    session_id = request.form.get("session", "").strip()
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"success": False, "message": "没有收到图片文件"}), 400
    if not allowed_upload(file.filename):
        return jsonify({"success": False, "message": "只支持 jpg/png/webp 图片"}), 400

    with state.lock:
        current_session = state.session
        if session_id != current_session.session_id:
            return jsonify({"success": False, "message": "二维码已失效，请重新扫码"}), 410
        if current_session.locked:
            return jsonify({"success": False, "message": "本轮体验已锁定，暂时不能继续上传"}), 409

        ext = Path(file.filename).suffix.lower()
        filename = f"{current_session.session_id}_{int(time.time())}{ext}"
        save_path = UPLOAD_DIR / secure_filename(filename)
        file.save(save_path)

        points, source = analyze_xray_with_optional_ai(save_path)
        current_session.xray_filename = save_path.name
        current_session.spine_points = points
        current_session.analysis_source = source

    socketio.emit(
        "xray_uploaded",
        {
            "session_id": session_id,
            "analysis_source": source,
            "points": points,
        },
    )
    return jsonify({"success": True, "message": "已上传，请按开始按钮"})


@app.post("/generate")
def generate() -> Any:
    payload = request.get_json(silent=True) or {}
    blend_final = float(payload.get("blend_final", state.sensor.blend))
    breath_count = int(payload.get("breath_count", 0))
    avg_intensity = float(payload.get("avg_intensity", blend_final))

    with state.lock:
        current_session = state.session
        poster_name = f"poster_{current_session.session_id}_{int(time.time())}.png"
        poster_path = POSTER_DIR / poster_name
        render_poster(poster_path, current_session, blend_final, breath_count, avg_intensity)
        current_session.poster_name = poster_name
        current_session.poster_prompt = json.dumps(
            {
                "blend_final": blend_final,
                "breath_count": breath_count,
                "avg_intensity": avg_intensity,
            },
            ensure_ascii=False,
        )
        state.mode = "SHOWING"

    poster_url = build_poster_url(poster_name)
    view_url = build_view_url(poster_name)
    qr_data_url = make_qr_data_url(view_url)

    socketio.emit(
        "poster_ready",
        {
            "poster_name": poster_name,
            "poster_url": poster_url,
            "view_url": view_url,
            "qr_data_url": qr_data_url,
        },
    )
    emit_state_change(mode="SHOWING")
    return jsonify(
        {
            "success": True,
            "poster_name": poster_name,
            "poster_url": poster_url,
            "view_url": view_url,
            "qr_data_url": qr_data_url,
        }
    )


@app.post("/reset")
def reset_route() -> Any:
    return jsonify(reset_system())


@app.get("/poster/<path:name>")
def poster_file(name: str) -> Any:
    return send_from_directory(POSTER_DIR, name)


@app.get("/view/<path:name>")
def poster_view(name: str) -> Any:
    image_url = build_poster_url(name)
    if image_url is None:
        return "海报不存在", 404
    return render_template("view.html", image_url=image_url, name=name)


@socketio.on("connect")
def on_connect() -> None:
    snapshot = state.snapshot()
    emit_state_change(mode=snapshot["mode"], room=request.sid)
    emit_session_update(room=request.sid)
    emit_sensor(state.sensor, room=request.sid)


@socketio.on("button_press")
def on_button_press(data: dict[str, Any] | None = None) -> None:
    _ = data
    with state.lock:
        current_mode = state.mode
    if current_mode == "IDLE":
        start_guide_flow()
        return
    if current_mode in {"SHOWING", "WAITING", "TRANSITION"}:
        reset_system()


@socketio.on("admin_reset")
def on_admin_reset() -> None:
    reset_system()


@socketio.on("set_blend")
def on_set_blend(data: dict[str, Any] | None = None) -> None:
    if not data:
        return
    try:
        blend = clamp(float(data.get("value", 0.0)), 0.0, 1.0)
    except Exception:
        return

    with state.lock:
        state.debug_override = True
        state.sensor = SensorSnapshot(
            blend=blend,
            raw_blend=blend,
            source="debug",
            updated_at=time.time(),
        )
        snapshot = state.sensor
    emit_sensor(snapshot)


@socketio.on("set_weights")
def on_set_weights(data: dict[str, Any] | None = None) -> None:
    if not data:
        return
    try:
        chest = float(data.get("weight_chest", DEFAULT_WEIGHT_CHEST))
        waist = float(data.get("weight_waist", DEFAULT_WEIGHT_WAIST))
    except Exception:
        return
    total = chest + waist
    if total <= 0:
        return
    with state.lock:
        state.weight_chest = chest / total
        state.weight_waist = waist / total
    serial_bridge.sync_runtime_to_arduino()
    emit_state_change()


@socketio.on("set_threshold")
def on_set_threshold(data: dict[str, Any] | None = None) -> None:
    if not data:
        return
    try:
        threshold = float(data.get("threshold", DEFAULT_THRESHOLD))
    except Exception:
        return
    if threshold <= 0:
        return
    with state.lock:
        state.threshold = threshold
    serial_bridge.sync_runtime_to_arduino()
    emit_state_change()


def main() -> None:
    logger.info("Flask-SocketIO 启动中，模式=%s", ASYNC_MODE)
    logger.info("局域网访问: http://%s:%s", guess_local_ip(), PORT)
    logger.info("公网配置: %s", PUBLIC_URL)
    serial_bridge.start()
    emit_session_update()
    socketio.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
