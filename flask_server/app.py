from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import io
import json
import logging
import os
import queue
import random
import re
import ssl
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
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

try:
    import websocket
except Exception:
    websocket = None


BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "templates"
RUNTIME_DIR = BASE_DIR / "runtime"
UPLOAD_DIR = RUNTIME_DIR / "uploads"
POSTER_DIR = RUNTIME_DIR / "posters"

for folder in (RUNTIME_DIR, UPLOAD_DIR, POSTER_DIR):
    folder.mkdir(parents=True, exist_ok=True)


def load_local_env() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_local_env()


HOST = "0.0.0.0"
PORT = 5000
SERIAL_BAUD = 115200
SERIAL_RETRY_SEC = 3
GUIDE_DURATION_SEC = 86
GUIDE_MOTOR_START_SEC = float(os.getenv("GUIDE_MOTOR_START_SEC", "43.8"))
EXPERIENCE_DURATION_SEC = 120
ENDING_DURATION_SEC = 4.2
TRANSITION_DURATION_SEC = 18
SUMMARY_DURATION_SEC = 30
DEFAULT_WEIGHT_CHEST = 1.0
DEFAULT_WEIGHT_WAIST = 0.0
DEFAULT_THRESHOLD = 520.0
CHEST_COUNTERPRESSURE_WEIGHT = 0.35
PREVIEW_BLEND_DEADBAND = 0.05
PREVIEW_BLEND_THRESHOLD_RATIO = 0.25
PREVIEW_BLEND_SMOOTHING = 0.08
EXPERIENCE_MIN_FLOOR_RATE = 0.002
EXPERIENCE_CLIMAX_EXTRA_RATE = 0.005
EXPERIENCE_SENSOR_RISE_RATE = 0.020
EXPERIENCE_TEACHING_SEC = 30.0
EXPERIENCE_SENSITIVITY_FADE_SEC = 15.0
EXPERIENCE_CLIMAX_SEC = 30.0
MAX_SERIAL_DT_SEC = 0.5
PUBLIC_URL = os.getenv("PUBLIC_URL", f"http://localhost:{PORT}").rstrip("/")
START_COMMAND = os.getenv("ARDUINO_START_COMMAND", "START")
RESET_COMMAND = os.getenv("ARDUINO_RESET_COMMAND", "RESET")
MOTOR_OFF_COMMAND = os.getenv("ARDUINO_MOTOR_OFF_COMMAND", "MOTOR_OFF")
DOUBLE_PULSE_COMMAND = os.getenv("ARDUINO_DOUBLE_PULSE_COMMAND", "MOTOR_DOUBLE_PULSE")
DISABLE_SERIAL = os.getenv("DISABLE_SERIAL", "").strip().lower() in {"1", "true", "yes", "on"}

ALLOWED_UPLOAD_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
SERIAL_LINE_PATTERN = re.compile(r"([A-Za-z0-9_]+):([-+]?\d+(?:\.\d+)?)")
DEFAULT_STATE_PAYLOAD_FIELDS = ("mode", "session_id", "blend", "serial_connected", "serial_port", "threshold")
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
VOICE_REPLY_MAX_CHARS = 90
SUMMARY_COPY_MAX_CHARS = 64
VOICE_SYSTEM_PROMPT = """
你是沉浸式交互作品《脊时呼吸》的待机状态语音。

你的任务是帮助观众理解作品、放松下来，并清楚知道接下来要做什么。
你不是工作人员、医生、导览员、客服、冥想老师，也不要说自己是AI、API、系统或入口旁白。
你像作品本身在轻声回应观众，但回答必须清楚、具体、容易听懂。

一、作品背景

《脊时呼吸》是一件面向脊柱侧弯患者呼吸训练的智能交互装置设计。
它通过影像、呼吸感知和身体互动，让观众理解脊柱侧弯中的身体不对称、呼吸空间和身体觉察。

当前是待机阶段。
待机画面主要呈现粒子脊柱、呼吸声波和安静的空间氛围。
此时观众还没有进入正式体验，所以画面中不会出现藤蔓、叶片和花朵。

正式体验开始后，观众的呼吸会逐渐影响影像变化。
粒子脊柱会随着呼吸慢慢趋向舒展，并在体验过程中逐步生长出藤蔓、叶片和花朵。
这些变化象征身体在呼吸中的调整、安定、连接与重新生长。

二、待机阶段的核心任务

你在待机阶段主要承担三个作用：

1. 新手指引：
让观众知道这件作品是什么、如何体验、下一步该做什么。

2. 作品介绍：
用清楚、温和的语言介绍脊柱侧弯、施罗斯呼吸法、呼吸感知和粒子脊柱影像。

3. 情绪安抚：
帮助观众慢慢进入平静、专注、愿意感受身体的状态。
这种安抚是心理上的陪伴和身体觉察，不是医学治疗，也不是疗愈承诺。

三、体验流程说明

当前观众处于待机状态，还没有正式进入体验。
观众可以先了解作品，也可以和你简单对话。

如果观众想体验，请清楚告诉他：
“请先穿上呼吸感知设备，将两个传感器贴紧背部左右两侧胸廓最厚的位置。站到体验位置后，说出‘开始’。”

正式体验前，观众需要穿上呼吸感知设备。
设备上有两个呼吸传感器，需要分别紧贴在背部左右两侧胸廓最厚、呼吸起伏较明显的位置。
佩戴时要保持贴合，不要悬空或松动，这样作品才能更稳定地感知背部呼吸变化。

当观众说出关键词“开始”时，作品会进入引导阶段。
引导阶段会通过动画介绍脊柱侧弯、身体不对称和施罗斯呼吸法的基本原理。
引导结束后，作品会自然过渡到正式体验阶段。

四、操作指引原则

你需要明确告诉观众下一步该做什么。
当观众问“怎么体验”“我该做什么”“怎么开始”“可以开始了吗”“我准备好了”等问题时，优先回答体验步骤。

体验步骤是：

1. 先穿上呼吸感知设备；
2. 将两个传感器贴紧背部左右两侧胸廓最厚的位置；
3. 站到体验位置；
4. 准备好后说出“开始”。

不要只用抽象、诗性的语言回应操作问题。
不要让观众猜测下一步。
不要说“你可以探索”“跟随身体的召唤”这类不明确的话。
可以温和，但必须说清楚。

五、设备说明边界

可以告诉观众：
- 需要穿上呼吸感知设备；
- 设备上有两个传感器；
- 传感器需要贴紧背部左右两侧胸廓最厚的位置；
- 传感器不要悬空、不要松动；
- 设备会感知背部呼吸变化，并让影像回应呼吸。

不要主动提及：
- blend值；
- 算法；
- 技术实现；
- API；
- 后台逻辑；
- 制作流程；
- 具体数值判断方式。

如果观众问为什么要贴在那里，可以回答：
“那里更容易感受到背部胸廓随呼吸产生的变化。”

如果观众问设备怎么工作，只用体验层面的语言回答：
“它会感知你背部呼吸的变化，并把这种变化转化为影像中脊柱的生长。”

不要继续解释更深的技术细节。

六、关于施罗斯呼吸法

施罗斯呼吸法是一种常用于脊柱侧弯康复训练中的呼吸训练方法。
它关注身体两侧的不对称，引导患者感知较塌陷或受限的呼吸空间，并配合姿态调整进行训练。

你只能做通俗介绍。
不要说它可以治愈、矫正或治疗疾病。
不要提供医学诊断、康复方案或具体训练处方。

七、心理安抚与身体觉察

作品带有平静、安抚和身体觉察的体验倾向。
你可以用温和的话语帮助观众放慢注意力，感到被理解和陪伴。
可以引导观众感受“当下”“身体的存在”“脊柱的重量”“呼吸与空间”。

但当前仍是待机阶段，不要提前带领正式呼吸训练。

不要说：
“闭上眼睛。”
“深呼吸。”
“跟着我吸气呼气。”
“我会带你进入疗愈。”
“这个作品可以治疗你。”
“你的身体会被修复。”

可以说：
“你可以先安静地站在这里，慢慢进入作品的节奏。”
“在开始之前，只需要让身体停下来，感受此刻的自己。”
“这里不需要急着改变身体，只需要让自己慢慢靠近呼吸。”
“如果你有一点紧张，也没关系，作品会从温和的引导开始。”

八、对脊柱侧弯患者的表达

保持共情、尊重和克制。
不要把患者描述成脆弱、痛苦或被修复的对象。
不要使用“正常身体”“异常身体”“畸形”等带有评判感的表达。

可以表达：
“每一条弯曲的脊柱，都有自己的重量和适应方式。”
“这个作品不是评判身体，而是让身体被看见、被理解。”
“身体的不对称并不只是问题，也是一种需要被耐心理解的经验。”

九、回答方式

使用中文回答。
每次回答一到两句话。
不超过90个中文字符。
除非观众明确要求详细介绍，否则不要输出长段说明。

回答以信息清楚为第一优先，诗意只作为轻微的语气。
语气安静、温和、克制，有一点艺术感，但不要玄乎。
不要使用晦涩、空泛、谜语一样的句子。
不要每次都用同一种句式。
不要过度抒情。
不要制造神秘感、宗教感或仪式感。
不要机械重复观众的话。
不要输出固定模板。

十、根据观众意图回答

遇到不同问题时，请判断观众真正想知道什么：

1. 问操作：
优先说明穿设备、贴传感器、站到体验位置、说“开始”。

2. 问作品：
说明它关于脊柱侧弯、呼吸训练、身体感知和影像互动。

3. 问施罗斯呼吸法：
用通俗语言解释，不做医学承诺。

4. 问设备：
只说体验层面的感知作用，不展开技术实现。

5. 问情绪：
温柔安抚，让观众慢慢安静下来。

6. 问画面：
区分待机阶段和正式体验阶段。
待机阶段没有藤蔓、叶片和花朵；它们会在正式体验中随着呼吸逐渐出现。

7. 问医疗效果：
明确说明作品不是医疗设备，不做诊断，也不承诺治疗。

十一、关键词规则

如果观众表达想开始、准备好了、可以体验了、进入下一步等意思，但没有说出关键词“开始”，你要提醒：
“请确认传感器已经贴紧背部胸廓。准备好后，说出‘开始’。”

如果观众直接说“开始”，只回答一句简短确认：
“好的，正在进入引导阶段。”

观众说“开始”后，不要继续介绍作品，不要继续解释流程。

十二、模糊输入处理

如果听不清或观众的问题很模糊，请温柔地请观众再说一次。

例如：
“我没有完全听清，可以再靠近一点说一遍吗？”

十三、示例使用规则

以下示例只用于学习语气、长度和回答方向。
不要逐字照搬示例。
不要把示例当成固定话术。
遇到相似问题时，请根据观众的真实问题自然回答。

示例：

观众问：这是做什么的？
回答：这是一个关于脊柱、呼吸和身体感知的交互装置。它会让呼吸中的身体变化被看见。

观众问：我该怎么体验？
回答：请先穿上呼吸感知设备，让两个传感器贴紧背部左右胸廓最厚的位置。准备好后，说出“开始”。

观众问：传感器贴哪里？
回答：请贴在背部左右两侧胸廓最厚、呼吸起伏较明显的位置，并保持贴合。

观众问：什么是施罗斯呼吸法？
回答：它是一种关注脊柱侧弯身体不对称的呼吸训练方法，帮助人感知受限的呼吸空间。

观众问：这个能治疗脊柱侧弯吗？
回答：它不是医疗治疗设备，而是帮助人理解呼吸、脊柱和身体感知之间的关系。

观众问：我有点紧张。
回答：没关系，你可以先安静地站在这里。这个作品不会评判身体，只是陪你慢慢感受它。

观众问：现在为什么没有藤蔓和花？
回答：现在还在待机阶段。进入正式体验后，它们会随着你的呼吸逐渐出现。

观众问：我不知道怎么呼吸。
回答：现在还不用练习呼吸。说出“开始”后，作品会先用动画带你了解呼吸方式。

观众说：开始。
回答：好的，正在进入引导阶段。

观众说的话很模糊。
回答：我没有完全听清，可以再靠近一点说一遍吗？
""".strip()
VOICE_FALLBACK_REPLIES = (
    "这句话还没有完全落成形。你可以再靠近一点，慢慢说一次。",
    "我听见了一些声音，但还没有辨清它的方向。你可以再说一遍。",
    "信号有些散开了。你可以问我作品是什么，也可以说“开始”。",
    "这片粒子暂时没有接住完整的问题。请再轻轻说一次。",
)
XUNFEI_IAT_HOST = "iat-api.xfyun.cn"
XUNFEI_IAT_PATH = "/v2/iat"
XUNFEI_IAT_URL = f"wss://{XUNFEI_IAT_HOST}{XUNFEI_IAT_PATH}"
ASR_FRAME_INTERVAL_SEC = 0.04


logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("raina.flask")

app = Flask(__name__, template_folder=str(TEMPLATE_DIR))
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "raina-dev-secret")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode=ASYNC_MODE)


@app.after_request
def add_cors_headers(response: Any) -> Any:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


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
        self.flow_revision = 0
        self.weight_chest = DEFAULT_WEIGHT_CHEST
        self.weight_waist = DEFAULT_WEIGHT_WAIST
        self.threshold = DEFAULT_THRESHOLD
        self.sensor = SensorSnapshot()
        self.serial_connected = False
        self.serial_port = ""
        self.debug_override = False
        self.experience_started_at: float | None = None
        self.last_blend_update_at: float | None = None
        self.final_blend: float | None = None
        self.session = self._new_session()

    def _new_session(self) -> SessionBundle:
        return SessionBundle(session_id=uuid.uuid4().hex[:12], created_at=time.time())

    def reset_for_new_session(self) -> SessionBundle:
        self.mode = "IDLE"
        self.flow_revision += 1
        self.sensor = SensorSnapshot()
        self.debug_override = False
        self.experience_started_at = None
        self.last_blend_update_at = None
        self.final_blend = None
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
                "final_blend": self.final_blend,
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
    if payload.get("mode") in {"ENDING", "SUMMARY"} and payload.get("final_blend") is not None:
        payload["blend"] = payload["final_blend"]
    else:
        payload["blend"] = payload["sensor"]["blend"]
    slim = {key: payload.get(key) for key in DEFAULT_STATE_PAYLOAD_FIELDS}
    slim.update(extra)
    if "blend" not in slim:
        slim["blend"] = payload["blend"]
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
        previous_blend = state.sensor.blend
        use_arduino_blend = state.mode == "EXPERIENCE" and "B" in payload
        if use_arduino_blend:
            now = time.time()
            if state.experience_started_at is None:
                state.experience_started_at = now
            if state.last_blend_update_at is None:
                state.last_blend_update_at = now

            raw = clamp(payload["B"] / 255.0, 0.0, 1.0)
            elapsed = max(0.0, now - state.experience_started_at)
            dt = clamp(now - state.last_blend_update_at, 0.0, MAX_SERIAL_DT_SEC)
            state.last_blend_update_at = now

            if elapsed < EXPERIENCE_TEACHING_SEC:
                sensitivity = 1.5
            elif elapsed < EXPERIENCE_TEACHING_SEC + EXPERIENCE_SENSITIVITY_FADE_SEC:
                fade = (elapsed - EXPERIENCE_TEACHING_SEC) / EXPERIENCE_SENSITIVITY_FADE_SEC
                sensitivity = 1.5 - 0.5 * clamp(fade, 0.0, 1.0)
            else:
                sensitivity = 1.0

            sensor_rate = raw * sensitivity * EXPERIENCE_SENSOR_RISE_RATE
            floor_rate = EXPERIENCE_MIN_FLOOR_RATE
            if elapsed >= max(0.0, EXPERIENCE_DURATION_SEC - EXPERIENCE_CLIMAX_SEC):
                floor_rate += EXPERIENCE_CLIMAX_EXTRA_RATE

            # PRD: 传感器贡献和保底增长叠加；按现场要求保留“只上升、不回退”。
            next_blend = previous_blend + (sensor_rate + floor_rate) * dt
            return raw, clamp(next_blend, 0.0, 1.0)

        chest = payload.get("S1", 0.0) - payload.get("S2", 0.0) * CHEST_COUNTERPRESSURE_WEIGHT
        waist = payload.get("S4", 0.0) - payload.get("S3", 0.0)
        raw_score = chest * state.weight_chest + waist * state.weight_waist
        if state.mode in {"ENDING", "SUMMARY"} and state.final_blend is not None:
            return raw_score, state.final_blend
        if state.mode != "EXPERIENCE":
            return raw_score, 0.0
        preview_threshold = max(state.threshold * PREVIEW_BLEND_THRESHOLD_RATIO, 1.0)
        normalized = clamp(raw_score / preview_threshold, 0.0, 1.0)
        if normalized <= PREVIEW_BLEND_DEADBAND:
            normalized = 0.0
        else:
            normalized = (normalized - PREVIEW_BLEND_DEADBAND) / (1.0 - PREVIEW_BLEND_DEADBAND)

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
    if mode == "ENDING":
        logger.info("体验结束，触发 Arduino 双短震")
        serial_bridge.enqueue(DOUBLE_PULSE_COMMAND)
        return
    if mode in {"TRANSITION", "WAITING", "SUMMARY", "IDLE"}:
        logger.info("离开体验阶段，停止 Arduino 呼吸节奏")
        serial_bridge.enqueue(RESET_COMMAND)


def clear_blend_accumulator() -> None:
    now = time.time()
    state.sensor.blend = 0.0
    state.sensor.raw_blend = 0.0
    state.experience_started_at = now
    state.last_blend_update_at = now


def schedule_experience_tail(flow_revision: int) -> None:
    schedule_state_change(EXPERIENCE_DURATION_SEC, "EXPERIENCE", "ENDING", flow_revision)
    schedule_state_change(EXPERIENCE_DURATION_SEC + ENDING_DURATION_SEC, "ENDING", "SUMMARY", flow_revision)
    schedule_state_change(
        EXPERIENCE_DURATION_SEC + ENDING_DURATION_SEC + SUMMARY_DURATION_SEC,
        "SUMMARY",
        "IDLE",
        flow_revision,
    )


def schedule_guide_motor_start(flow_revision: int) -> None:
    session_id = state.session.session_id

    def _task() -> None:
        socketio.sleep(GUIDE_MOTOR_START_SEC)
        with state.lock:
            if (
                state.session.session_id != session_id
                or state.mode != "GUIDE"
                or state.flow_revision != flow_revision
            ):
                return
        logger.info("GUIDE 呼吸引导段开始，启动 Arduino 振动")
        serial_bridge.enqueue(START_COMMAND)

    socketio.start_background_task(_task)


def schedule_state_change(delay_sec: float, expected_mode: str, next_mode: str, flow_revision: int) -> None:
    session_id = state.session.session_id

    def _task() -> None:
        socketio.sleep(delay_sec)
        with state.lock:
            if (
                state.session.session_id != session_id
                or state.mode != expected_mode
                or state.flow_revision != flow_revision
            ):
                return
            state.mode = next_mode
            next_revision = flow_revision
            if next_mode == "EXPERIENCE":
                state.flow_revision += 1
                state.final_blend = None
                clear_blend_accumulator()
                next_revision = state.flow_revision
            elif next_mode == "ENDING":
                state.final_blend = clamp(state.sensor.blend, 0.0, 1.0)
                state.sensor.blend = state.final_blend
            elif next_mode == "IDLE":
                state.reset_for_new_session()
        sync_arduino_for_mode(next_mode)
        emit_state_change(mode=next_mode)
        if next_mode == "IDLE":
            emit_session_update()
        if next_mode == "EXPERIENCE":
            schedule_experience_tail(next_revision)

    socketio.start_background_task(_task)


def start_guide_flow() -> dict[str, Any]:
    with state.lock:
        if state.mode != "IDLE":
            return state.snapshot()
        state.mode = "GUIDE"
        state.flow_revision += 1
        state.session.locked = True
        state.debug_override = False
        flow_revision = state.flow_revision
        snapshot = state.snapshot()

    emit_state_change(mode="START_GUIDE")
    schedule_guide_motor_start(flow_revision)
    schedule_state_change(GUIDE_DURATION_SEC, "GUIDE", "EXPERIENCE", flow_revision)
    return snapshot


def skip_guide_flow() -> dict[str, Any]:
    with state.lock:
        if state.mode != "GUIDE":
            return state.snapshot()
        state.mode = "EXPERIENCE"
        state.flow_revision += 1
        state.final_blend = None
        clear_blend_accumulator()
        flow_revision = state.flow_revision
        snapshot = state.snapshot()

    sync_arduino_for_mode("EXPERIENCE")
    emit_state_change(mode="EXPERIENCE")
    schedule_experience_tail(flow_revision)
    return snapshot


def reset_system() -> dict[str, Any]:
    with state.lock:
        state.reset_for_new_session()
        snapshot = state.snapshot()
    serial_bridge.enqueue(MOTOR_OFF_COMMAND)
    serial_bridge.enqueue(RESET_COMMAND)
    serial_bridge.enqueue(RESET_COMMAND)
    socketio.emit("reset", {"session_id": snapshot["session_id"]})
    emit_state_change(mode="IDLE")
    emit_session_update()
    return snapshot


def fallback_voice_reply(text: str) -> str:
    return random.choice(VOICE_FALLBACK_REPLIES)


def trim_voice_reply(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    cleaned = cleaned.strip("`")
    if len(cleaned) <= VOICE_REPLY_MAX_CHARS:
        return cleaned
    return cleaned[:VOICE_REPLY_MAX_CHARS].rstrip("，。；、 ") + "。"


def trim_summary_copy(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip().strip("`")
    cleaned = cleaned.replace("“", "").replace("”", "").replace('"', "")
    if len(cleaned) <= SUMMARY_COPY_MAX_CHARS:
        return cleaned
    return cleaned[:SUMMARY_COPY_MAX_CHARS].rstrip("，。；、 ") + "。"


def fallback_summary_copy(blend_final: float) -> str:
    options = [
        "你没有改变身体的全部，却已经让它被温柔地看见。",
        "这一段呼吸留下了痕迹，像身体重新找回一点空间。",
        "弯曲仍在，但呼吸让它有了松动、回应和新的方向。",
        "你的身体没有被评判，它只是在呼吸里慢慢靠近自己。",
    ]
    if blend_final > 0.72:
        options.append("呼吸把弯曲处轻轻展开，身体记住了这一刻的空间。")
    elif blend_final < 0.28:
        options.append("即使变化很轻，身体也已经开始听见自己的呼吸。")
    return random.choice(options)


def deepseek_summary_copy(blend_final: float) -> tuple[str, str]:
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return fallback_summary_copy(blend_final), "fallback"

    percent = int(round(clamp(blend_final, 0.0, 1.0) * 100))
    messages = [
        {
            "role": "system",
            "content": (
                "你为沉浸式交互作品《脊时呼吸》的体验结算页写一句中文短文案。"
                "作品关于脊柱侧弯、呼吸训练和身体觉察。"
                "语气温柔、克制、有艺术感，但不要玄乎。"
                "不要说治愈、治疗、矫正、修复、康复成功。"
                "不要提 AI、系统、算法、数值。"
                "只输出一句话，不超过64个中文字符。"
            ),
        },
        {
            "role": "user",
            "content": f"本次体验结束时，脊柱影像变化进度约为 {percent}%。请写一句结算页文案。",
        },
    ]
    payload = json.dumps(
        {
            "model": DEEPSEEK_MODEL,
            "messages": messages,
            "temperature": 0.95,
            "max_tokens": 90,
            "stream": False,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        DEEPSEEK_API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        return trim_summary_copy(content), "deepseek"
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, IndexError, json.JSONDecodeError) as exc:
        logger.warning("DeepSeek 结算文案失败，使用本地回退：%s", exc)
        return fallback_summary_copy(blend_final), "fallback"


def deepseek_voice_reply(text: str) -> tuple[str, str]:
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return fallback_voice_reply(text), "fallback"

    messages = [
        {
            "role": "system",
            "content": VOICE_SYSTEM_PROMPT,
        },
        {"role": "user", "content": text},
    ]
    payload = json.dumps(
        {
            "model": DEEPSEEK_MODEL,
            "messages": messages,
            "temperature": 0.85,
            "max_tokens": 120,
            "stream": False,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        DEEPSEEK_API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        return trim_voice_reply(content), "deepseek"
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, IndexError, json.JSONDecodeError) as exc:
        logger.warning("DeepSeek 语音回答失败，使用本地回退：%s", exc)
        return fallback_voice_reply(text), "fallback"


def build_xunfei_iat_url() -> str:
    api_key = os.getenv("XUNFEI_API_KEY", "").strip()
    api_secret = os.getenv("XUNFEI_API_SECRET", "").strip()
    if not api_key or not api_secret:
        raise RuntimeError("缺少 XUNFEI_API_KEY / XUNFEI_API_SECRET")
    date = datetime.datetime.utcnow().strftime("%a, %d %b %Y %H:%M:%S GMT")
    signature_origin = f"host: {XUNFEI_IAT_HOST}\ndate: {date}\nGET {XUNFEI_IAT_PATH} HTTP/1.1"
    signature_sha = hmac.new(
        api_secret.encode("utf-8"),
        signature_origin.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()
    signature = base64.b64encode(signature_sha).decode("utf-8")
    authorization_origin = (
        f'api_key="{api_key}", algorithm="hmac-sha256", '
        f'headers="host date request-line", signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode("utf-8")).decode("utf-8")
    query = urllib.parse.urlencode({"authorization": authorization, "date": date, "host": XUNFEI_IAT_HOST})
    return f"{XUNFEI_IAT_URL}?{query}"


def parse_xunfei_text(payload: dict[str, Any]) -> tuple[str, bool]:
    data = payload.get("data") or {}
    result = data.get("result") or {}
    words: list[str] = []
    for ws in result.get("ws") or []:
        for cw in ws.get("cw") or []:
            word = str(cw.get("w", ""))
            if word:
                words.append(word)
    return "".join(words), int(data.get("status", 0)) == 2


def asr_debug(label: str, **detail: Any) -> None:
    logger.info("[asr-debug] %s %s", label, detail)


class XunfeiIATSession:
    def __init__(self, sid: str) -> None:
        self.sid = sid
        self.frames: queue.Queue[str | None] = queue.Queue()
        self.closed = threading.Event()
        self.ws: Any = None
        self.text = ""
        self.queued_frames = 0
        self.sent_frames = 0
        self.received_messages = 0
        self.worker = threading.Thread(target=self.run, daemon=True)

    def start(self) -> None:
        self.worker.start()

    def enqueue_audio(self, audio_b64: str) -> None:
        if not self.closed.is_set() and audio_b64:
            self.queued_frames += 1
            if self.queued_frames <= 3 or self.queued_frames % 20 == 0:
                asr_debug("frontend_audio_queued", sid=self.sid, queued_frames=self.queued_frames, bytes=len(audio_b64))
            self.frames.put(audio_b64)

    def stop(self) -> None:
        if not self.closed.is_set():
            asr_debug("frontend_stop", sid=self.sid, queued_frames=self.queued_frames, sent_frames=self.sent_frames)
            self.frames.put(None)

    def emit_error(self, message: str) -> None:
        socketio.emit("asr_error", {"message": message}, to=self.sid)

    def send_frame(self, audio_b64: str, status: int) -> None:
        appid = os.getenv("XUNFEI_APPID", "").strip()
        frame: dict[str, Any] = {
            "data": {
                "status": status,
                "format": "audio/L16;rate=16000",
                "audio": audio_b64,
                "encoding": "raw",
            }
        }
        if status == 0:
            frame["common"] = {"app_id": appid}
            frame["business"] = {
                "language": "zh_cn",
                "domain": "iat",
                "accent": "mandarin",
                "vad_eos": 2000,
            }
        self.ws.send(json.dumps(frame, ensure_ascii=False))
        if status != 2:
            self.sent_frames += 1
        if status == 0 or status == 2 or self.sent_frames <= 3 or self.sent_frames % 20 == 0:
            asr_debug("xunfei_frame_sent", sid=self.sid, status=status, sent_frames=self.sent_frames, audio_bytes=len(audio_b64))

    def receive_loop(self) -> None:
        while not self.closed.is_set():
            try:
                message = self.ws.recv()
            except Exception:
                return
            if not message:
                return
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                asr_debug("xunfei_bad_json", sid=self.sid, raw=message[:180])
                continue
            self.received_messages += 1
            code = int(payload.get("code", 0))
            data = payload.get("data") or {}
            result = data.get("result") or {}
            asr_debug(
                "xunfei_payload",
                sid=self.sid,
                message_count=self.received_messages,
                code=code,
                status=data.get("status"),
                has_result=bool(result),
                message=payload.get("message"),
            )
            if code != 0:
                self.emit_error(str(payload.get("message", "讯飞识别失败")))
                self.closed.set()
                return
            piece, is_final = parse_xunfei_text(payload)
            asr_debug("xunfei_text", sid=self.sid, piece=piece, accumulated=self.text + piece, final=is_final)
            if piece:
                self.text += piece
                socketio.emit("asr_result", {"text": self.text, "piece": piece, "final": is_final}, to=self.sid)
            if is_final:
                socketio.emit("asr_result", {"text": self.text, "piece": "", "final": True}, to=self.sid)
                self.closed.set()
                return

    def run(self) -> None:
        if websocket is None:
            self.emit_error("后端缺少 websocket-client，请安装 requirements.txt")
            self.closed.set()
            return
        if not os.getenv("XUNFEI_APPID", "").strip():
            self.emit_error("缺少 XUNFEI_APPID")
            self.closed.set()
            return
        try:
            asr_debug("session_connecting", sid=self.sid)
            self.ws = websocket.create_connection(
                build_xunfei_iat_url(),
                timeout=8,
                sslopt={"cert_reqs": ssl.CERT_NONE},
            )
            asr_debug("session_connected", sid=self.sid)
            receiver = threading.Thread(target=self.receive_loop, daemon=True)
            receiver.start()
            first = True
            while not self.closed.is_set():
                frame = self.frames.get()
                if frame is None:
                    self.send_frame("", 2)
                    break
                self.send_frame(frame, 0 if first else 1)
                first = False
                time.sleep(ASR_FRAME_INTERVAL_SEC)
            receiver.join(timeout=3)
            asr_debug("session_finished", sid=self.sid, text=self.text, sent_frames=self.sent_frames, received_messages=self.received_messages)
        except Exception as exc:
            logger.warning("讯飞 IAT 会话失败：%s", exc)
            self.emit_error("讯飞语音识别连接失败")
        finally:
            self.closed.set()
            try:
                if self.ws:
                    self.ws.close()
            except Exception:
                pass


asr_sessions: dict[str, XunfeiIATSession] = {}


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


@app.route("/voice/reply", methods=["POST", "OPTIONS"])
def voice_reply() -> Any:
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).strip()
    mode = str(payload.get("mode", state.mode)).strip() or state.mode
    if not text:
        return jsonify({"success": False, "message": "缺少语音文本"}), 400
    if mode != "IDLE":
        return jsonify({"success": False, "message": "仅 IDLE 阶段响应语音问答"}), 409
    reply, source = deepseek_voice_reply(text)
    return jsonify({"success": True, "reply": reply, "source": source})


@app.route("/voice/summary", methods=["POST", "OPTIONS"])
def voice_summary() -> Any:
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(silent=True) or {}
    try:
        blend_final = clamp(float(payload.get("blend_final", state.sensor.blend)), 0.0, 1.0)
    except (TypeError, ValueError):
        blend_final = state.sensor.blend
    copy, source = deepseek_summary_copy(blend_final)
    return jsonify({"success": True, "copy": copy, "source": source})


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
    if current_mode in {"SHOWING", "WAITING", "TRANSITION", "SUMMARY"}:
        reset_system()


@socketio.on("admin_reset")
def on_admin_reset() -> None:
    reset_system()


@socketio.on("skip_guide")
def on_skip_guide() -> None:
    skip_guide_flow()


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


@socketio.on("asr_start")
def on_asr_start(data: dict[str, Any] | None = None) -> None:
    _ = data
    old = asr_sessions.pop(request.sid, None)
    if old:
        asr_debug("socket_start_replacing_old", sid=request.sid)
        old.stop()
    asr_debug("socket_start", sid=request.sid)
    session = XunfeiIATSession(request.sid)
    asr_sessions[request.sid] = session
    session.start()
    socketio.emit("asr_status", {"status": "started"}, to=request.sid)


@socketio.on("asr_audio")
def on_asr_audio(data: dict[str, Any] | None = None) -> None:
    if not data:
        asr_debug("socket_audio_empty", sid=request.sid)
        return
    audio = str(data.get("audio", ""))
    session = asr_sessions.get(request.sid)
    if session:
        session.enqueue_audio(audio)
    else:
        asr_debug("socket_audio_without_session", sid=request.sid, bytes=len(audio))


@socketio.on("asr_stop")
def on_asr_stop() -> None:
    session = asr_sessions.get(request.sid)
    if session:
        session.stop()
    else:
        asr_debug("socket_stop_without_session", sid=request.sid)


@socketio.on("disconnect")
def on_disconnect() -> None:
    session = asr_sessions.pop(request.sid, None)
    if session:
        session.stop()
    with state.lock:
        should_reset = state.mode in {"GUIDE", "EXPERIENCE", "ENDING"}
    if should_reset:
        logger.info("前端断开，自动重置并停止 Arduino")
        reset_system()


def main() -> None:
    logger.info("Flask-SocketIO 启动中，模式=%s", ASYNC_MODE)
    logger.info("局域网访问: http://%s:%s", guess_local_ip(), PORT)
    logger.info("公网配置: %s", PUBLIC_URL)
    if DISABLE_SERIAL:
        logger.info("已禁用 Arduino 串口桥接。")
    else:
        serial_bridge.start()
    emit_session_update()
    socketio.run(app, host=HOST, port=PORT, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
