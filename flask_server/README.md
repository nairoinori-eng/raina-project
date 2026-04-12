# Flask 后台

这个目录提供脊柱侧弯交互装置的 Flask 后台最小闭环，包含：

- Arduino 串口桥接
- Flask-SocketIO 实时推送
- 手机上传页
- 海报生成与查看页
- 状态重置与二维码刷新

## 目录

- `app.py`：主服务
- `templates/upload.html`：手机上传页
- `templates/view.html`：海报查看页
- `requirements.txt`：Python 依赖
- `后端方案.md`：实现方案与接口说明

## 启动

```powershell
cd flask_server
pip install -r requirements.txt
python app.py
```

如果你的机器上还没有 Python，请先安装 Python 3.11+。

## 环境变量

- `PUBLIC_URL`：公网地址，默认 `http://localhost:5000`
- `GEMINI_API_KEY`：可选，有值时尝试调用 Gemini 做 X 光坐标提取
- `ARDUINO_PORT`：可选，手动指定串口，例如 `COM4`
- `ARDUINO_START_COMMAND`：可选，默认 `START`
- `ARDUINO_RESET_COMMAND`：可选，默认 `RESET`

## Socket.IO 事件

- 服务端发给前端：
  - `sensor_data`
  - `state_change`
  - `session_update`
  - `poster_ready`
  - `xray_uploaded`
  - `reset`
- 前端发给服务端：
  - `button_press`
  - `admin_reset`
  - `set_blend`
  - `set_weights`
  - `set_threshold`

## HTTP 路由

- `GET /status`
- `GET /upload`
- `POST /upload`
- `POST /generate`
- `POST /reset`
- `GET /poster/<name>`
- `GET /view/<name>`

## 当前实现说明

- 有串口时优先读取 Arduino 的 `B` 值，没有 `B` 时按 `S1/S2/S3/S4` 重算 blend。
- 有 `GEMINI_API_KEY` 时尝试走 Gemini；失败时自动回退到内置脊柱点，不会让上传流程中断。
- 海报生成为 Pillow 本地图像，不依赖外部图像生成接口，方便你先把展览流程跑通。
