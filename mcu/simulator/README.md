# 单片机逻辑仿真器

这个目录里的脚本不是电路仿真，而是“正式展出版固件的逻辑仿真”。

它的作用是先在电脑上验证下面这些内容：

- `START / MOTOR_ON / MOTOR_OFF / WEIGHT / THRESHOLD / RESET` 命令有没有明显逻辑问题
- `S1/S2/S3/S4 -> raw -> baseline -> B` 这一整条计算链是不是符合预期
- 呼吸节奏下马达 PWM 是否按代码逻辑变化
- 弱呼吸时低 `blend` 提醒是否会触发
- 运行中 `RESET` 后状态是否回到 `IDLE`

它不能替代真实上板，因为它验证不了：

- 传感器贴合度
- `S9012` 实物脚位是否和 datasheet 一致
- 马达电流、发热、噪声
- USB 串口在真实电脑上的占用和抖动

## 运行方法

在项目根目录执行：

```powershell
node .\mcu\simulator\raina_show_firmware_sim.js
```

## 当前内置场景

- `默认权重_正确呼吸`
- `默认权重_弱呼吸`
- `腰部主导权重`
- `中途关马达`
- `运行后重置`

## 输出怎么看

脚本会输出一份 JSON，总结每个场景的：

- `peakBlend`：最高 `B`
- `averageBlend`：平均 `B`
- `reminderFrames`：低 `blend` 提醒脉冲触发帧数
- `inhaleFrames`：呼吸节奏马达工作帧数
- `finalMode`：场景结束时状态
- `sampleFrameAtEnd`：最后一帧串口格式示例

## 当前这份结果的结论

- 正确呼吸场景下，`B` 会稳定抬升，不会误触发低 `blend` 提醒
- 弱呼吸场景下，`B` 会持续较低，并触发提醒脉冲
- `WEIGHT` 和 `THRESHOLD` 修改后，输出会随之变化
- `MOTOR_OFF` / `MOTOR_ON` 在运行中能切换
- `RESET` 后状态能回到 `IDLE`

## 建议怎么用

1. 先跑这个仿真器，确认固件逻辑没有明显矛盾
2. 再烧录 `raina_mcu_test.ino` 做真实硬件联调
3. 最后再烧录 `raina_mcu_show.ino` 用于正式展出
