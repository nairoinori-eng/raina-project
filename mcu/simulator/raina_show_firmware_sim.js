class SensorFilter {
  constructor(windowSize) {
    this.samples = new Array(windowSize).fill(0);
    this.sum = 0;
    this.index = 0;
    this.filled = false;
    this.windowSize = windowSize;
  }

  update(rawValue) {
    this.sum -= this.samples[this.index];
    this.samples[this.index] = rawValue;
    this.sum += rawValue;
    this.index = (this.index + 1) % this.windowSize;
    if (!this.filled && this.index === 0) {
      this.filled = true;
    }

    let divisor = this.filled ? this.windowSize : this.index;
    if (divisor === 0) {
      divisor = 1;
    }
    return Math.trunc(this.sum / divisor);
  }
}

class RainaShowFirmwareSim {
  constructor() {
    this.SAMPLE_INTERVAL_MS = 33;
    this.SENSOR_COUNT = 4;
    this.FILTER_WINDOW = 5;

    this.DEFAULT_WEIGHT_CHEST = 0.6;
    this.DEFAULT_WEIGHT_WAIST = 0.4;
    this.DEFAULT_THRESHOLD = 200.0;

    this.BASELINE_WINDOW_SAMPLES = 90;

    this.BREATH_CYCLE_MS = 10000;
    this.INHALE_MS = 4000;
    this.HOLD_MS = 2000;
    this.EXHALE_MS = 4000;

    this.MOTOR_PREPULSE_PWM = 200;
    this.MOTOR_INHALE_PWM = 165;
    this.MOTOR_REMINDER_PWM = 125;

    this.PREPULSE_ON_MS = 50;
    this.PREPULSE_GAP_MS = 50;
    this.PREPULSE_COUNT = 3;
    this.PREPULSE_TOTAL_MS =
      (this.PREPULSE_COUNT * this.PREPULSE_ON_MS) +
      ((this.PREPULSE_COUNT - 1) * this.PREPULSE_GAP_MS);

    this.LOW_BLEND_THRESHOLD = 30;
    this.LOW_BLEND_REMINDER_DELAY_MS = 10000;
    this.LOW_BLEND_REMINDER_PULSE_MS = 120;

    this.MODE_IDLE = "IDLE";
    this.MODE_GUIDE = "GUIDE";
    this.MODE_RUNNING = "RUNNING";

    this.resetAll();
  }

  resetAll() {
    this.filters = Array.from(
      { length: this.SENSOR_COUNT },
      () => new SensorFilter(this.FILTER_WINDOW),
    );
    this.filteredSensors = [0, 0, 0, 0];
    this.baselineHistory = new Array(this.BASELINE_WINDOW_SAMPLES).fill(0);
    this.baselineIndex = 0;
    this.baselineCount = 0;
    this.baselineSum = 0;
    this.frozenBaseline = 0;

    this.weightChest = this.DEFAULT_WEIGHT_CHEST;
    this.weightWaist = this.DEFAULT_WEIGHT_WAIST;
    this.thresholdValue = this.DEFAULT_THRESHOLD;

    this.currentRawScore = 0;
    this.currentAdjustedScore = 0;
    this.currentBlend = 0;
    this.currentMotorPwm = 0;

    this.runMode = this.MODE_IDLE;
    this.motorsEnabled = true;

    this.nowMs = 0;
    this.runningSinceMs = 0;
    this.lowBlendSinceMs = 0;
    this.reminderUntilMs = 0;
    this.nextReminderEligibleMs = 0;
  }

  clearBaselineHistory() {
    this.baselineIndex = 0;
    this.baselineCount = 0;
    this.baselineSum = 0;
    this.frozenBaseline = 0;
    this.baselineHistory.fill(0);
  }

  addBaselineSample(score) {
    if (this.runMode === this.MODE_RUNNING) {
      return;
    }

    if (this.baselineCount < this.BASELINE_WINDOW_SAMPLES) {
      this.baselineHistory[this.baselineIndex] = score;
      this.baselineSum += score;
      this.baselineCount += 1;
      this.baselineIndex = (this.baselineIndex + 1) % this.BASELINE_WINDOW_SAMPLES;
      return;
    }

    this.baselineSum -= this.baselineHistory[this.baselineIndex];
    this.baselineHistory[this.baselineIndex] = score;
    this.baselineSum += score;
    this.baselineIndex = (this.baselineIndex + 1) % this.BASELINE_WINDOW_SAMPLES;
  }

  getBaselineAverage() {
    if (this.baselineCount === 0) {
      return this.currentRawScore;
    }
    return this.baselineSum / this.baselineCount;
  }

  freezeBaselineFromRollingWindow() {
    this.frozenBaseline = this.getBaselineAverage();
  }

  scoreToBlendByte(adjustedScore) {
    if (this.thresholdValue <= 0) {
      return 0;
    }

    const normalized = adjustedScore / this.thresholdValue;
    if (normalized <= 0) {
      return 0;
    }
    if (normalized >= 1) {
      return 255;
    }
    return Math.trunc(normalized * 255);
  }

  normalizeWeights(requestedChest, requestedWaist) {
    const total = requestedChest + requestedWaist;
    if (total <= 0) {
      return false;
    }
    this.weightChest = requestedChest / total;
    this.weightWaist = requestedWaist / total;
    this.clearBaselineHistory();
    return true;
  }

  enterGuideMode() {
    this.runMode = this.MODE_GUIDE;
  }

  startExperience() {
    this.freezeBaselineFromRollingWindow();
    this.runMode = this.MODE_RUNNING;
    this.runningSinceMs = this.nowMs;
    this.lowBlendSinceMs = 0;
    this.reminderUntilMs = 0;
    this.nextReminderEligibleMs = this.runningSinceMs + this.LOW_BLEND_REMINDER_DELAY_MS;
  }

  resetSessionState() {
    this.runMode = this.MODE_IDLE;
    this.motorsEnabled = true;
    this.weightChest = this.DEFAULT_WEIGHT_CHEST;
    this.weightWaist = this.DEFAULT_WEIGHT_WAIST;
    this.thresholdValue = this.DEFAULT_THRESHOLD;
    this.currentAdjustedScore = 0;
    this.currentBlend = 0;
    this.currentMotorPwm = 0;
    this.lowBlendSinceMs = 0;
    this.reminderUntilMs = 0;
    this.nextReminderEligibleMs = 0;
    this.clearBaselineHistory();
  }

  handleCommand(command) {
    if (command === "START" || command === "EXPERIENCE_START") {
      this.startExperience();
      return { ok: true, event: "RUNNING" };
    }

    if (command === "GUIDE_START") {
      this.enterGuideMode();
      return { ok: true, event: "GUIDE_READY" };
    }

    if (command === "MOTOR_OFF") {
      this.motorsEnabled = false;
      this.currentMotorPwm = 0;
      return { ok: true, event: "MOTOR_OFF" };
    }

    if (command === "MOTOR_ON") {
      this.motorsEnabled = true;
      return { ok: true, event: "MOTOR_ON" };
    }

    if (command === "CAPTURE_BASELINE") {
      this.freezeBaselineFromRollingWindow();
      return { ok: true, event: "BASELINE_CAPTURED" };
    }

    if (command === "STATUS") {
      return {
        ok: true,
        event: "STATUS",
        mode: this.runMode,
        baseline: this.frozenBaseline,
        rolling: this.getBaselineAverage(),
        raw: this.currentRawScore,
        adjusted: this.currentAdjustedScore,
        blend: this.currentBlend,
        weightChest: this.weightChest,
        weightWaist: this.weightWaist,
        threshold: this.thresholdValue,
        motorsEnabled: this.motorsEnabled,
      };
    }

    if (command === "RESET") {
      this.resetSessionState();
      return { ok: true, event: "RESET" };
    }

    if (command.startsWith("WEIGHT:")) {
      const payload = command.slice(7).split(",");
      if (payload.length !== 2) {
        return { ok: false, event: "ERR_WEIGHT" };
      }
      const chest = Number(payload[0]);
      const waist = Number(payload[1]);
      if (!Number.isFinite(chest) || !Number.isFinite(waist)) {
        return { ok: false, event: "ERR_WEIGHT" };
      }
      const ok = this.normalizeWeights(chest, waist);
      return {
        ok,
        event: ok ? "WEIGHT_UPDATED" : "ERR_WEIGHT",
      };
    }

    if (command.startsWith("THRESHOLD:")) {
      const value = Number(command.slice(10));
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, event: "ERR_THRESHOLD" };
      }
      this.thresholdValue = value;
      return { ok: true, event: "THRESHOLD_UPDATED" };
    }

    return { ok: false, event: "ERR_COMMAND" };
  }

  breathingCuePwm() {
    const elapsed = this.nowMs - this.runningSinceMs;
    const cycleMs = elapsed % this.BREATH_CYCLE_MS;

    if (cycleMs < this.PREPULSE_TOTAL_MS) {
      const chunk = this.PREPULSE_ON_MS + this.PREPULSE_GAP_MS;
      const pulseIndex = Math.trunc(cycleMs / chunk);
      if (pulseIndex < this.PREPULSE_COUNT) {
        const pulseOffset = cycleMs % chunk;
        if (pulseOffset < this.PREPULSE_ON_MS) {
          return this.MOTOR_PREPULSE_PWM;
        }
      }
      return 0;
    }

    if (cycleMs < this.INHALE_MS) {
      return this.MOTOR_INHALE_PWM;
    }

    if (cycleMs < (this.INHALE_MS + this.HOLD_MS + this.EXHALE_MS)) {
      return 0;
    }

    return 0;
  }

  updateLowBlendReminder() {
    if (this.runMode !== this.MODE_RUNNING) {
      this.lowBlendSinceMs = 0;
      this.reminderUntilMs = 0;
      this.nextReminderEligibleMs = 0;
      return;
    }

    if (this.currentBlend < this.LOW_BLEND_THRESHOLD) {
      if (this.lowBlendSinceMs === 0) {
        this.lowBlendSinceMs = this.nowMs;
      }
    } else {
      this.lowBlendSinceMs = 0;
      this.reminderUntilMs = 0;
      this.nextReminderEligibleMs = this.nowMs + this.LOW_BLEND_REMINDER_DELAY_MS;
      return;
    }

    if (
      this.lowBlendSinceMs > 0 &&
      this.nowMs >= this.nextReminderEligibleMs &&
      (this.nowMs - this.lowBlendSinceMs) >= this.LOW_BLEND_REMINDER_DELAY_MS
    ) {
      this.reminderUntilMs = this.nowMs + this.LOW_BLEND_REMINDER_PULSE_MS;
      this.nextReminderEligibleMs = this.nowMs + this.LOW_BLEND_REMINDER_DELAY_MS;
    }
  }

  updateMotors() {
    if (this.runMode !== this.MODE_RUNNING || !this.motorsEnabled) {
      this.currentMotorPwm = 0;
      return;
    }

    const cuePwm = this.breathingCuePwm();
    const reminderPwm = this.reminderUntilMs > this.nowMs ? this.MOTOR_REMINDER_PWM : 0;
    this.currentMotorPwm = Math.max(cuePwm, reminderPwm);
  }

  readSensorsAndComputeBlend(sensorValues) {
    for (let i = 0; i < this.SENSOR_COUNT; i += 1) {
      this.filteredSensors[i] = this.filters[i].update(sensorValues[i]);
    }

    const chestCorrection = this.filteredSensors[0] - this.filteredSensors[1];
    const waistCorrection = this.filteredSensors[3] - this.filteredSensors[2];

    this.currentRawScore =
      (chestCorrection * this.weightChest) +
      (waistCorrection * this.weightWaist);

    this.addBaselineSample(this.currentRawScore);

    if (this.runMode === this.MODE_RUNNING) {
      this.currentAdjustedScore = this.currentRawScore - this.frozenBaseline;
      if (this.currentAdjustedScore < 0) {
        this.currentAdjustedScore = 0;
      }
      this.currentBlend = this.scoreToBlendByte(this.currentAdjustedScore);
    } else {
      this.currentAdjustedScore = 0;
      this.currentBlend = 0;
    }
  }

  sample(sensorValues) {
    this.readSensorsAndComputeBlend(sensorValues);
    this.updateLowBlendReminder();
    this.updateMotors();

    return {
      t: this.nowMs,
      mode: this.runMode,
      sensors: [...this.filteredSensors],
      raw: Number(this.currentRawScore.toFixed(2)),
      baseline: Number(this.frozenBaseline.toFixed(2)),
      adjusted: Number(this.currentAdjustedScore.toFixed(2)),
      blend: this.currentBlend,
      motorPwm: this.currentMotorPwm,
      frame: `S1:${this.filteredSensors[0]},S2:${this.filteredSensors[1]},S3:${this.filteredSensors[2]},S4:${this.filteredSensors[3]},B:${this.currentBlend}`,
    };
  }

  step(sensorValues) {
    this.nowMs += this.SAMPLE_INTERVAL_MS;
    return this.sample(sensorValues);
  }
}

function makeBreathingScenario({ inhaleBoostChest, inhaleBoostWaist, weak = false }) {
  return (tMs) => {
    const cycle = tMs % 10000;
    const inhalePhase = cycle < 4000 ? cycle / 4000 : cycle < 6000 ? 1 : Math.max(0, 1 - ((cycle - 6000) / 4000));

    const base = [260, 250, 245, 255];
    const chestDelta = (weak ? 0.35 : 1) * inhaleBoostChest * inhalePhase;
    const waistDelta = (weak ? 0.35 : 1) * inhaleBoostWaist * inhalePhase;

    return [
      Math.round(base[0] + chestDelta),
      Math.round(base[1]),
      Math.round(base[2]),
      Math.round(base[3] + waistDelta),
    ];
  };
}

function runScenario(name, config) {
  const sim = new RainaShowFirmwareSim();
  const timeline = [];
  const commands = [];

  const pushCommand = (command) => {
    const result = sim.handleCommand(command);
    commands.push({ t: sim.nowMs, command, result });
  };

  for (let i = 0; i < config.preRollSamples; i += 1) {
    timeline.push(sim.step(config.generator(sim.nowMs)));
  }

  if (config.beforeStartCommands) {
    for (const command of config.beforeStartCommands) {
      pushCommand(command);
    }
  }

  pushCommand("START");

  for (let i = 0; i < config.runSamples; i += 1) {
    if (config.midRunEvents) {
      for (const event of config.midRunEvents) {
        if (!event.fired && sim.nowMs >= event.atMs) {
          pushCommand(event.command);
          event.fired = true;
        }
      }
    }
    timeline.push(sim.step(config.generator(sim.nowMs)));
  }

  const peakBlend = timeline.reduce((max, item) => Math.max(max, item.blend), 0);
  const averageBlend =
    timeline.reduce((sum, item) => sum + item.blend, 0) / Math.max(timeline.length, 1);
  const reminderFrames = timeline.filter(
    (item) => item.motorPwm === sim.MOTOR_REMINDER_PWM,
  ).length;
  const inhaleFrames = timeline.filter(
    (item) => item.motorPwm === sim.MOTOR_INHALE_PWM || item.motorPwm === sim.MOTOR_PREPULSE_PWM,
  ).length;

  return {
    name,
    commands,
    summary: {
      peakBlend,
      averageBlend: Number(averageBlend.toFixed(2)),
      reminderFrames,
      inhaleFrames,
      finalMode: timeline[timeline.length - 1]?.mode ?? sim.runMode,
      finalBaseline: Number(sim.frozenBaseline.toFixed(2)),
      finalThreshold: sim.thresholdValue,
      finalWeights: [Number(sim.weightChest.toFixed(2)), Number(sim.weightWaist.toFixed(2))],
      sampleFrameAtEnd: timeline[timeline.length - 1]?.frame ?? "",
    },
  };
}

function main() {
  const scenarios = [
    runScenario("默认权重_正确呼吸", {
      generator: makeBreathingScenario({ inhaleBoostChest: 150, inhaleBoostWaist: 120 }),
      preRollSamples: 100,
      runSamples: 360,
    }),
    runScenario("默认权重_弱呼吸", {
      generator: makeBreathingScenario({ inhaleBoostChest: 60, inhaleBoostWaist: 45, weak: true }),
      preRollSamples: 100,
      runSamples: 420,
    }),
    runScenario("腰部主导权重", {
      generator: makeBreathingScenario({ inhaleBoostChest: 60, inhaleBoostWaist: 180 }),
      preRollSamples: 100,
      runSamples: 360,
      beforeStartCommands: ["WEIGHT:0.3,0.7", "THRESHOLD:180"],
    }),
    runScenario("中途关马达", {
      generator: makeBreathingScenario({ inhaleBoostChest: 130, inhaleBoostWaist: 100 }),
      preRollSamples: 100,
      runSamples: 360,
      midRunEvents: [
        { atMs: 6000, command: "MOTOR_OFF", fired: false },
        { atMs: 11000, command: "MOTOR_ON", fired: false },
      ],
    }),
    runScenario("运行后重置", {
      generator: makeBreathingScenario({ inhaleBoostChest: 140, inhaleBoostWaist: 140 }),
      preRollSamples: 100,
      runSamples: 240,
      midRunEvents: [
        { atMs: 5000, command: "RESET", fired: false },
      ],
    }),
  ];

  console.log(JSON.stringify({ simulatedAt: new Date().toISOString(), scenarios }, null, 2));
}

main();
