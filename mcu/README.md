# Raina 单片机固件

这个目录里有两套 Arduino 草图，用来驱动你的背心控制器：

- `raina_mcu_test`：联调、查线、标定、测马达
- `raina_mcu_show`：正式展出时使用的稳定版

## 硬件引脚对应

- `S1` 左胸 FSR -> `A0`
- `S2` 右胸 FSR -> `A1`
- `S3` 左腰 FSR -> `A2`
- `S4` 右腰 FSR -> `A3`
- `M1` 左胸马达 -> `D5`
- `M2` 右腰马达 -> `D6`
- 串口波特率 -> `115200`

## 三极管特别说明

原始方案文档里写的是 `S8050`，那是 NPN 管；你现在实际用的是 `S9012`，它是 PNP 管。  
因此两套固件里默认都用了：

```cpp
const bool MOTOR_ACTIVE_LOW = true;
```

这表示：

- Arduino 引脚输出 `LOW` 时，马达导通
- Arduino 引脚输出 `HIGH` 时，马达关闭

如果你烧录后遇到下面几种情况：

- 马达一直转不停
- 马达完全不转
- 马达开关逻辑和预期相反

先检查接线，再检查 `S9012` 的方向。  
只有当你的硬件实际上被改成了 NPN 低边驱动时，才需要把 `MOTOR_ACTIVE_LOW` 改成 `false`。

## 两套程序怎么用

### 1. `raina_mcu_test`

先上传这个。它主要用来确认：

- 4 个 FSR 都能正常变化
- 胸部和腰部左右差值方向是否正确
- 基线抓取是否合理
- 阈值和权重是否合适
- 两个马达能不能单独驱动
- 自动呼吸节奏马达测试是否正常

常用串口命令：

- `HELP`
- `STATUS`
- `STREAM_ON`
- `STREAM_OFF`
- `CAPTURE_BASELINE`
- `THRESHOLD:200`
- `WEIGHT:0.6,0.4`
- `MOTOR_ON`
- `MOTOR_OFF`
- `MOTOR_LEFT:200`
- `MOTOR_RIGHT:200`
- `MOTOR_BOTH:160`
- `MOTOR_STOP`
- `MOTOR_PULSE`
- `PATTERN_ON`
- `PATTERN_OFF`
- `POLARITY:LOW`
- `POLARITY:HIGH`
- `RESET`

输出示例：

```text
S1:118,S2:95,S3:82,S4:147,CHEST:23,WAIST:65,RAW:39.80,BASE:11.20,ADJ:28.60,B:36
```

字段含义：

- `CHEST`：胸部左右差值 `S1 - S2`
- `WAIST`：腰部左右差值 `S4 - S3`
- `RAW`：加权前后的实时原始分数
- `BASE`：当前冻结基线
- `ADJ`：扣掉基线后的有效分数
- `B`：映射到 `0~255` 的展示值

### 2. `raina_mcu_show`

正式展出时上传这个。它比测试版更安静，输出格式也更严格，方便后面的 Python/Flask 中间层读取。

支持的主要命令：

- `START`
- `GUIDE_START`
- `EXPERIENCE_START`
- `MOTOR_OFF`
- `MOTOR_ON`
- `WEIGHT:x.x,x.x`
- `THRESHOLD:value`
- `CAPTURE_BASELINE`
- `STATUS`
- `RESET`

持续输出格式：

```text
S1:xxx,S2:xxx,S3:xxx,S4:xxx,B:xxx
```

其中 `B` 是 `0~255` 的字节值。

## 建议标定流程

1. 先上传 `raina_mcu_test`
2. 打开串口监视器，波特率设成 `115200`
3. 穿好背心，保持自然站立几秒
4. 发送 `CAPTURE_BASELINE`
5. 先做平静呼吸，再做较强的施罗斯呼吸
6. 观察 `RAW`、`ADJ` 和 `B`
7. 用 `THRESHOLD:数值` 反复调，直到“做对的强呼吸”能稳定推高到你想要的区间
8. 把最终阈值同步到 `raina_mcu_show`

## 和现有前端的衔接

仓库里的 `spine-viz` 前端已经在等 `Socket.IO` 的 `sensor_data` 和 `state_change`。  
现在缺的是中间那层本地 Python 服务，它要做的事情很简单：

- 从串口读 `S1,S2,S3,S4,B`
- 把 `B / 255.0` 转成前端的 `blend`
- 转发按钮事件
- 转发状态切换

这两套固件就是按这条链路去设计的。
