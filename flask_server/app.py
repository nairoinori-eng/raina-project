"""
raina-project — Flask 后端主文件
====================================
作用：
  1. 通过 SocketIO 实时推送传感器数据给浏览器（Three.js 前端）
  2. 管理整个体验的状态机（IDLE→GUIDE→EXPERIENCE→...）
  3. 硬件到货后，这里的"模拟传感器"会替换成 pyserial 读取 Arduino

当前状态：【模拟模式】用数学函数模拟呼吸波形，不需要任何硬件
"""

from flask import Flask, jsonify
from flask_socketio import SocketIO, emit
import threading
import time
import math

# ============================================================
# 初始化 Flask 和 SocketIO
# ============================================================
app = Flask(__name__)
app.config['SECRET_KEY'] = 'raina-secret-2026'

# cors_allowed_origins="*" 允许 Vite 开发服务器（localhost:5173）跨域访问
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')


# ============================================================
# 全局状态（整个程序共享这一份数据）
# ============================================================
state = {
    'mode': 'IDLE',        # 当前阶段：IDLE / GUIDE / EXPERIENCE / TRANSITION / SHOWING
    'blend': 0.0,          # 脊柱弯直程度：0.0=完全弯曲, 1.0=完全变直
    'session_id': 'init',  # 每轮体验的唯一编号（重置后会更新）
}


# ============================================================
# 模拟传感器线程
# ============================================================
# ⚠️ 硬件到货后，把这整个函数替换成 pyserial 读取 Arduino 串口数据
# 替换后的逻辑：
#   ser = serial.Serial('/dev/tty.usbserial-xxx', 115200)
#   line = ser.readline().decode()  # 格式 "S1:xxx,S2:xxx,S3:xxx,S4:xxx,B:xxx"
#   B = int(line.split('B:')[1])
#   blend = B / 255.0
#   socketio.emit('sensor_data', {'blend': blend, 'mode': state['mode']})

def simulate_sensor_loop():
    """
    模拟传感器数据（正弦波模拟呼吸节奏）

    呼吸周期 10 秒：
      0-4s  吸气阶段 → blend 从 0 升到 0.8
      4-6s  停顿阶段 → blend 保持在 0.8
      6-10s 呼气阶段 → blend 从 0.8 降回 0

    只在 EXPERIENCE 阶段推送数据，其他阶段静默
    """
    t = 0.0
    while True:
        if state['mode'] == 'EXPERIENCE':
            cycle = t % 10.0  # 10 秒一个循环

            if cycle < 4.0:
                # 吸气：0 → 0.8
                raw_blend = (cycle / 4.0) * 0.8
            elif cycle < 6.0:
                # 停顿：保持 0.8
                raw_blend = 0.8
            else:
                # 呼气：0.8 → 0
                raw_blend = (1.0 - (cycle - 6.0) / 4.0) * 0.8

            state['blend'] = round(raw_blend, 3)

            # 推送给所有连接的浏览器
            socketio.emit('sensor_data', {
                'blend': state['blend'],
                'mode': state['mode'],
            })

        t += 0.1
        time.sleep(0.1)  # 10Hz 更新（真实 Arduino 是 30Hz，这里够用了）


# ============================================================
# SocketIO 事件处理
# ============================================================

@socketio.on('connect')
def handle_connect():
    """浏览器连上来时，立刻告诉它当前状态"""
    print(f'[连接] 前端已连接，当前状态: {state["mode"]}')
    emit('state_change', {
        'mode': state['mode'],
        'blend': state['blend'],
    })


@socketio.on('disconnect')
def handle_disconnect():
    print('[断开] 前端已断开连接')


@socketio.on('button_press')
def handle_button_press(data=None):
    """
    处理手持按钮信号

    按钮在两个阶段有效：
      IDLE    → 开始体验（进入 GUIDE 引导阶段）
      SHOWING → 重置，回到 IDLE 等待下一位
    其他阶段按下无效（防止误触）
    """
    current = state['mode']

    if current == 'IDLE':
        state['mode'] = 'GUIDE'
        print('[按钮] IDLE → GUIDE（开始引导）')
        socketio.emit('state_change', {'mode': 'GUIDE', 'blend': 0.0})

    elif current == 'SHOWING':
        # 重置：清空数据，回到待机
        state['mode'] = 'IDLE'
        state['blend'] = 0.0
        import uuid
        state['session_id'] = str(uuid.uuid4())[:8]  # 新的 session ID
        print('[按钮] SHOWING → IDLE（重置，新 session: {})'.format(state['session_id']))
        socketio.emit('state_change', {'mode': 'IDLE', 'blend': 0.0})

    else:
        print(f'[按钮] 当前 {current} 阶段，按钮无效')


@socketio.on('guide_complete')
def handle_guide_complete(data=None):
    """
    引导动画播完后，前端发这个事件
    → 切换到 EXPERIENCE（体验主体开始，传感器开始驱动粒子）
    """
    state['mode'] = 'EXPERIENCE'
    print('[引导] 引导结束 → EXPERIENCE（开始呼吸体验）')
    socketio.emit('state_change', {'mode': 'EXPERIENCE', 'blend': state['blend']})


@socketio.on('experience_end')
def handle_experience_end(data=None):
    """
    体验 120 秒计时结束，前端发这个事件
    → 切换到 TRANSITION（收束过渡 + 等待 AI 生图）
    """
    state['mode'] = 'TRANSITION'
    print('[体验] 120秒结束 → TRANSITION（收束过渡）')
    socketio.emit('state_change', {'mode': 'TRANSITION', 'blend': state['blend']})


@socketio.on('poster_ready')
def handle_poster_ready(data=None):
    """AI 海报生成完毕（或跳过），进入 SHOWING 展示阶段"""
    state['mode'] = 'SHOWING'
    print('[海报] 海报就绪 → SHOWING（展示+扫码）')
    socketio.emit('state_change', {'mode': 'SHOWING', 'blend': state['blend']})


@socketio.on('set_blend')
def handle_set_blend(data):
    """
    ⚠️ 调试专用——前端滑块直接设置 blend 值
    硬件到货、传感器正常工作后，这个接口就不再需要了

    用法：前端发 {'value': 0.75} → 这里广播给所有连接的浏览器
    """
    value = float(data.get('value', 0))
    value = max(0.0, min(1.0, value))  # 确保在 0-1 范围内
    state['blend'] = round(value, 3)

    # 广播给所有客户端（包括发送者）
    socketio.emit('sensor_data', {
        'blend': state['blend'],
        'mode': state['mode'],
    })


# ============================================================
# HTTP 路由
# ============================================================

@app.route('/')
def index():
    """心跳检测，访问这里确认服务在跑"""
    return '✅ raina-project Flask 服务正常运行<br>访问 <a href="/status">/status</a> 查看当前状态'


@app.route('/status')
def get_status():
    """返回当前系统状态（JSON 格式），方便调试"""
    return jsonify(state)


# ============================================================
# 启动
# ============================================================

if __name__ == '__main__':
    # 启动模拟传感器线程（daemon=True：主程序退出时自动结束）
    # ⚠️ 硬件到货后，把 simulate_sensor_loop 替换成 pyserial 读取函数
    sensor_thread = threading.Thread(target=simulate_sensor_loop, daemon=True)
    sensor_thread.start()
    print('🔵 [模拟传感器] 已启动（硬件到货后替换为 pyserial）')
    print('🟢 [Flask] 服务启动在 http://localhost:5000')
    print('📊 [状态查看] http://localhost:5000/status')
    print('-' * 50)

    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
