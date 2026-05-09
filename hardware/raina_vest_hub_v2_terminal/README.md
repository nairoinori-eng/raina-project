# RAINA 背心中转板 v2.0（推荐下单版）

v1 尝试把 Arduino Nano 直接插在 PCB 上，但手写 EasyEDA 文件无法保证 Nano 封装完全可靠。v2 改成更稳妥的方案：

```text
Arduino Nano 不直接插 PCB
Arduino Nano 通过 8 根短线连接到 PCB 的 J7 控制接口
PCB 只负责 FSR 分压、电机驱动、JST 接口
```

这个方案更适合毕业设计快速落地，因为 PCB 不再依赖 Nano 封装尺寸，只需要普通 2.54mm 端子/排针。

## 1. 文件

- `raina_vest_hub_v2_terminal.easyeda.json`：嘉立创EDA标准版导入文件
- `pins.md`：接口定义
- `bom.csv`：元件清单

## 2. 核心连接

板上有一个 `J7 TO_NANO` 8P 接口，连接 Arduino Nano：

| J7 Pin | 接 Arduino Nano |
|---|---|
| 1 | 5V |
| 2 | GND |
| 3 | A0 |
| 4 | A1 |
| 5 | A2 |
| 6 | A3 |
| 7 | D5 |
| 8 | D6 |

背心传感器/马达通过 JST 2P 接入：

| 接口 | 对象 |
|---|---|
| J1 | S1 左胸 FSR |
| J2 | S2 右胸 FSR |
| J3 | S3 左腰 FSR |
| J4 | S4 右腰 FSR |
| J5 | M1 左胸马达 |
| J6 | M2 右腰马达 |

## 3. 为什么 v2 更可靠

- 不需要 Arduino Nano 精确封装。
- 不怕 Nano 批次尺寸差异。
- Nano 坏了可以直接拔线换。
- PCB 上都是简单 2.54mm 直插元件，更容易检查。
- 下单风险比 v1 低很多。

## 4. 下单前检查

导入嘉立创EDA后必须检查：

1. J7 是 8 个 2.54mm 焊盘。
2. J1-J6 都是 2P 接口。
3. R1-R4 是 10K 下拉。
4. Q1/Q2 是 S9012，脚位必须按你手里的实物确认。
5. D1/D2 是马达保护二极管，建议焊上。
6. DRC 没有错误。

## 5. 实物接线方式

```text
Arduino Nano 5V  -> J7-1
Arduino Nano GND -> J7-2
Arduino Nano A0  -> J7-3
Arduino Nano A1  -> J7-4
Arduino Nano A2  -> J7-5
Arduino Nano A3  -> J7-6
Arduino Nano D5  -> J7-7
Arduino Nano D6  -> J7-8
```

你可以用 8P 杜邦排线、JST-XH 8P，或者 2.54mm 螺丝端子连接。

