#include <stdlib.h>
#include <string.h>

/*
  raina_mcu_show.ino
  Production firmware for exhibition use.
*/

const unsigned long SERIAL_BAUD = 115200UL;
const unsigned long SAMPLE_INTERVAL_MS = 33UL;

const byte SENSOR_COUNT = 4;
const byte FILTER_WINDOW = 5;
const byte SENSOR_PINS[SENSOR_COUNT] = {A0, A1, A2, A3};

const byte MOTOR_LEFT_PIN = 5;
const byte MOTOR_RIGHT_PIN = 6;
const bool MOTOR_ACTIVE_LOW = true;
// S9012 is a PNP transistor, so the motor driver is active-low.


const float DEFAULT_WEIGHT_CHEST = 0.60f;
const float DEFAULT_WEIGHT_WAIST = 0.40f;
const float DEFAULT_THRESHOLD = 1400.0f;

const unsigned int BASELINE_WINDOW_SAMPLES = 90;

const unsigned long INHALE_MS = 4000UL;
const unsigned long HOLD_MS = 2000UL;
const unsigned long EXHALE_MS = 4000UL;
const unsigned long CYCLE_GAP_MS = 2000UL;
const unsigned long BREATH_CYCLE_MS =
  INHALE_MS + HOLD_MS + EXHALE_MS + CYCLE_GAP_MS;

const byte MOTOR_CUE_PWM_MIN = 60;
const byte MOTOR_CUE_PWM_MAX = 220;
const unsigned long MOTOR_RAMP_MS = 2000UL;
const byte MOTOR_REMINDER_PWM = 125;

const bool LOW_BLEND_REMINDER_ENABLED = false;
const byte LOW_BLEND_THRESHOLD = 30;
const unsigned long LOW_BLEND_REMINDER_DELAY_MS = 10000UL;
const unsigned long LOW_BLEND_REMINDER_PULSE_MS = 120UL;

struct SensorFilter {
  int samples[FILTER_WINDOW];
  long sum;
  byte index;
  bool filled;
};

enum RunMode {
  MODE_IDLE,
  MODE_GUIDE,
  MODE_RUNNING
};

SensorFilter filters[SENSOR_COUNT];
int filteredSensors[SENSOR_COUNT] = {0, 0, 0, 0};

float baselineHistory[BASELINE_WINDOW_SAMPLES];
unsigned int baselineIndex = 0;
unsigned int baselineCount = 0;
float baselineSum = 0.0f;
float frozenBaseline = 0.0f;

float weightChest = DEFAULT_WEIGHT_CHEST;
float weightWaist = DEFAULT_WEIGHT_WAIST;
float thresholdValue = DEFAULT_THRESHOLD;

float currentRawScore = 0.0f;
float currentAdjustedScore = 0.0f;
byte currentBlend = 0;

RunMode runMode = MODE_IDLE;
bool motorsEnabled = true;

unsigned long lastSampleAt = 0UL;
unsigned long runningSinceMs = 0UL;
unsigned long lowBlendSinceMs = 0UL;
unsigned long reminderUntilMs = 0UL;
unsigned long nextReminderEligibleMs = 0UL;

char commandBuffer[80];
byte commandLength = 0;

void initFilter(SensorFilter &filter) {
  filter.sum = 0;
  filter.index = 0;
  filter.filled = false;
  for (byte i = 0; i < FILTER_WINDOW; ++i) {
    filter.samples[i] = 0;
  }
}

int updateFilter(SensorFilter &filter, int rawValue) {
  filter.sum -= filter.samples[filter.index];
  filter.samples[filter.index] = rawValue;
  filter.sum += rawValue;
  filter.index = (filter.index + 1) % FILTER_WINDOW;
  if (!filter.filled && filter.index == 0) {
    filter.filled = true;
  }

  byte divisor = filter.filled ? FILTER_WINDOW : filter.index;
  if (divisor == 0) {
    divisor = 1;
  }
  return (int)(filter.sum / divisor);
}

void clearBaselineHistory() {
  baselineIndex = 0;
  baselineCount = 0;
  baselineSum = 0.0f;
  frozenBaseline = 0.0f;
  for (unsigned int i = 0; i < BASELINE_WINDOW_SAMPLES; ++i) {
    baselineHistory[i] = 0.0f;
  }
}

void addBaselineSample(float score) {
  if (runMode == MODE_RUNNING) {
    return;
  }

  if (baselineCount < BASELINE_WINDOW_SAMPLES) {
    baselineHistory[baselineIndex] = score;
    baselineSum += score;
    baselineCount++;
    baselineIndex = (baselineIndex + 1) % BASELINE_WINDOW_SAMPLES;
    return;
  }

  baselineSum -= baselineHistory[baselineIndex];
  baselineHistory[baselineIndex] = score;
  baselineSum += score;
  baselineIndex = (baselineIndex + 1) % BASELINE_WINDOW_SAMPLES;
}

float getBaselineAverage() {
  if (baselineCount == 0) {
    return currentRawScore;
  }
  return baselineSum / (float)baselineCount;
}

void freezeBaselineFromRollingWindow() {
  frozenBaseline = getBaselineAverage();
}

byte scoreToBlendByte(float adjustedScore) {
  if (thresholdValue <= 0.0f) {
    return 0;
  }

  float normalized = adjustedScore / thresholdValue;
  if (normalized <= 0.0f) {
    return 0;
  }
  if (normalized >= 1.0f) {
    return 255;
  }
  return (byte)(normalized * 255.0f);
}

void setMotorPwm(byte pin, byte pwm) {
  int duty = pwm;
  if (duty < 0) {
    duty = 0;
  }
  if (duty > 255) {
    duty = 255;
  }

  if (MOTOR_ACTIVE_LOW) {
    analogWrite(pin, 255 - duty);
  } else {
    analogWrite(pin, duty);
  }
}

void stopAllMotors() {
  setMotorPwm(MOTOR_LEFT_PIN, 0);
  setMotorPwm(MOTOR_RIGHT_PIN, 0);
}

byte interpolatePwm(byte startPwm, byte endPwm, unsigned long elapsedMs, unsigned long durationMs) {
  if (durationMs == 0UL || elapsedMs >= durationMs) {
    return endPwm;
  }

  long delta = (long)endPwm - (long)startPwm;
  long step = ((long)elapsedMs * delta) / (long)durationMs;
  return (byte)((long)startPwm + step);
}

const char *modeName(RunMode mode) {
  switch (mode) {
    case MODE_IDLE: return "IDLE";
    case MODE_GUIDE: return "GUIDE";
    case MODE_RUNNING: return "RUNNING";
    default: return "UNKNOWN";
  }
}

void emitCommentLine(const char *message) {
  Serial.print("# ");
  Serial.println(message);
}

void emitStatusLine() {
  Serial.print("# STATUS mode=");
  Serial.print(modeName(runMode));
  Serial.print(" baseline=");
  Serial.print(frozenBaseline, 2);
  Serial.print(" rolling=");
  Serial.print(getBaselineAverage(), 2);
  Serial.print(" raw=");
  Serial.print(currentRawScore, 2);
  Serial.print(" adj=");
  Serial.print(currentAdjustedScore, 2);
  Serial.print(" blend=");
  Serial.print(currentBlend);
  Serial.print(" weight=");
  Serial.print(weightChest, 3);
  Serial.print(",");
  Serial.print(weightWaist, 3);
  Serial.print(" threshold=");
  Serial.print(thresholdValue, 2);
  Serial.print(" motors=");
  Serial.println(motorsEnabled ? "ON" : "OFF");
}

void normalizeWeights(float requestedChest, float requestedWaist) {
  float total = requestedChest + requestedWaist;
  if (total <= 0.0f) {
    return;
  }
  weightChest = requestedChest / total;
  weightWaist = requestedWaist / total;
  clearBaselineHistory();
}

bool parseTwoFloats(const char *payload, float &first, float &second) {
  char local[40];
  byte i = 0;
  while (payload[i] != '\0' && i < sizeof(local) - 1) {
    local[i] = payload[i];
    i++;
  }
  local[i] = '\0';

  char *comma = strchr(local, ',');
  if (comma == NULL) {
    return false;
  }
  *comma = '\0';
  first = atof(local);
  second = atof(comma + 1);
  return true;
}

void enterGuideMode() {
  runMode = MODE_GUIDE;
  emitCommentLine("GUIDE_READY");
}

void startExperience() {
  unsigned long nowMs = millis();
  freezeBaselineFromRollingWindow();
  runMode = MODE_RUNNING;
  runningSinceMs = nowMs;
  lowBlendSinceMs = 0UL;
  reminderUntilMs = 0UL;
  nextReminderEligibleMs = nowMs + LOW_BLEND_REMINDER_DELAY_MS;
  emitCommentLine("RUNNING");
}

void resetSessionState() {
  runMode = MODE_IDLE;
  motorsEnabled = true;
  weightChest = DEFAULT_WEIGHT_CHEST;
  weightWaist = DEFAULT_WEIGHT_WAIST;
  currentAdjustedScore = 0.0f;
  currentBlend = 0;
  lowBlendSinceMs = 0UL;
  reminderUntilMs = 0UL;
  nextReminderEligibleMs = 0UL;
  clearBaselineHistory();
  stopAllMotors();
  emitCommentLine("RESET");
}

void handleCommand(const char *command) {
  if (strcmp(command, "START") == 0 || strcmp(command, "EXPERIENCE_START") == 0) {
    startExperience();
    return;
  }

  if (strcmp(command, "GUIDE_START") == 0) {
    enterGuideMode();
    return;
  }

  if (strcmp(command, "MOTOR_OFF") == 0) {
    motorsEnabled = false;
    stopAllMotors();
    emitCommentLine("MOTOR_OFF");
    return;
  }

  if (strcmp(command, "MOTOR_ON") == 0) {
    motorsEnabled = true;
    emitCommentLine("MOTOR_ON");
    return;
  }

  if (strcmp(command, "CAPTURE_BASELINE") == 0) {
    freezeBaselineFromRollingWindow();
    emitCommentLine("BASELINE_CAPTURED");
    return;
  }

  if (strcmp(command, "STATUS") == 0) {
    emitStatusLine();
    return;
  }

  if (strcmp(command, "RESET") == 0) {
    resetSessionState();
    return;
  }

  if (strncmp(command, "WEIGHT:", 7) == 0) {
    float nextChest = 0.0f;
    float nextWaist = 0.0f;
    if (parseTwoFloats(command + 7, nextChest, nextWaist)) {
      normalizeWeights(nextChest, nextWaist);
      emitCommentLine("WEIGHT_UPDATED");
    } else {
      emitCommentLine("ERR_WEIGHT");
    }
    return;
  }

  if (strncmp(command, "THRESHOLD:", 10) == 0) {
    float nextThreshold = atof(command + 10);
    if (nextThreshold > 0.0f) {
      thresholdValue = nextThreshold;
      emitCommentLine("THRESHOLD_UPDATED");
    } else {
      emitCommentLine("ERR_THRESHOLD");
    }
    return;
  }

  emitCommentLine("ERR_COMMAND");
}

void serviceSerialInput() {
  while (Serial.available() > 0) {
    char incoming = (char)Serial.read();
    if (incoming == '\r') {
      continue;
    }

    if (incoming == '\n') {
      commandBuffer[commandLength] = '\0';
      if (commandLength > 0) {
        handleCommand(commandBuffer);
      }
      commandLength = 0;
      continue;
    }

    if (commandLength < sizeof(commandBuffer) - 1) {
      commandBuffer[commandLength++] = incoming;
    } else {
      commandLength = 0;
      emitCommentLine("ERR_BUFFER");
    }
  }
}

byte breathingCuePwm(unsigned long nowMs) {
  unsigned long elapsed = nowMs - runningSinceMs;
  unsigned long cycleMs = elapsed % BREATH_CYCLE_MS;
  unsigned long inhaleEndMs = INHALE_MS;
  unsigned long holdEndMs = inhaleEndMs + HOLD_MS;
  unsigned long exhaleEndMs = holdEndMs + EXHALE_MS;

  if (cycleMs < inhaleEndMs) {
    if (cycleMs < MOTOR_RAMP_MS) {
      return interpolatePwm(MOTOR_CUE_PWM_MIN, MOTOR_CUE_PWM_MAX, cycleMs, MOTOR_RAMP_MS);
    }
    return MOTOR_CUE_PWM_MAX;
  }

  if (cycleMs < holdEndMs) {
    return 0;
  }

  if (cycleMs < exhaleEndMs) {
    unsigned long exhalePhaseMs = cycleMs - holdEndMs;
    if (exhalePhaseMs < MOTOR_RAMP_MS) {
      return MOTOR_CUE_PWM_MAX;
    }
    return interpolatePwm(
      MOTOR_CUE_PWM_MAX,
      MOTOR_CUE_PWM_MIN,
      exhalePhaseMs - MOTOR_RAMP_MS,
      EXHALE_MS - MOTOR_RAMP_MS
    );
  }

  return 0;
}

void updateLowBlendReminder(unsigned long nowMs) {
  if (!LOW_BLEND_REMINDER_ENABLED || runMode != MODE_RUNNING) {
    lowBlendSinceMs = 0UL;
    reminderUntilMs = 0UL;
    nextReminderEligibleMs = 0UL;
    return;
  }

  if (currentBlend < LOW_BLEND_THRESHOLD) {
    if (lowBlendSinceMs == 0UL) {
      lowBlendSinceMs = nowMs;
    }
  } else {
    lowBlendSinceMs = 0UL;
    reminderUntilMs = 0UL;
    nextReminderEligibleMs = nowMs + LOW_BLEND_REMINDER_DELAY_MS;
    return;
  }

  if (lowBlendSinceMs > 0UL &&
      nowMs >= nextReminderEligibleMs &&
      (nowMs - lowBlendSinceMs) >= LOW_BLEND_REMINDER_DELAY_MS) {
    reminderUntilMs = nowMs + LOW_BLEND_REMINDER_PULSE_MS;
    nextReminderEligibleMs = nowMs + LOW_BLEND_REMINDER_DELAY_MS;
  }
}

void updateMotors(unsigned long nowMs) {
  if (runMode != MODE_RUNNING || !motorsEnabled) {
    stopAllMotors();
    return;
  }

  byte cuePwm = breathingCuePwm(nowMs);
  byte reminderPwm = 0;
  if (reminderUntilMs > nowMs) {
    reminderPwm = MOTOR_REMINDER_PWM;
  }

  byte finalPwm = cuePwm;
  if (reminderPwm > finalPwm) {
    finalPwm = reminderPwm;
  }

  setMotorPwm(MOTOR_LEFT_PIN, finalPwm);
  setMotorPwm(MOTOR_RIGHT_PIN, finalPwm);
}

void readSensorsAndComputeBlend() {
  for (byte i = 0; i < SENSOR_COUNT; ++i) {
    int rawValue = analogRead(SENSOR_PINS[i]);
    filteredSensors[i] = updateFilter(filters[i], rawValue);
  }

  int chestCorrection = filteredSensors[0] - filteredSensors[1];
  int waistCorrection = filteredSensors[3] - filteredSensors[2];

  currentRawScore =
    (chestCorrection * weightChest) +
    (waistCorrection * weightWaist);

  addBaselineSample(currentRawScore);

  if (runMode == MODE_RUNNING) {
    currentAdjustedScore = currentRawScore - frozenBaseline;
    if (currentAdjustedScore < 0.0f) {
      currentAdjustedScore = 0.0f;
    }
    currentBlend = scoreToBlendByte(currentAdjustedScore);
  } else {
    currentAdjustedScore = 0.0f;
    currentBlend = 0;
  }
}

void emitSensorFrame() {
  Serial.print("S1:");
  Serial.print(filteredSensors[0]);
  Serial.print(",S2:");
  Serial.print(filteredSensors[1]);
  Serial.print(",S3:");
  Serial.print(filteredSensors[2]);
  Serial.print(",S4:");
  Serial.print(filteredSensors[3]);
  Serial.print(",B:");
  Serial.println(currentBlend);
}

void setup() {
  Serial.begin(SERIAL_BAUD);

  for (byte i = 0; i < SENSOR_COUNT; ++i) {
    initFilter(filters[i]);
  }

  pinMode(MOTOR_LEFT_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_PIN, OUTPUT);
  stopAllMotors();

  clearBaselineHistory();
  emitCommentLine("RAINA_MCU_SHOW_READY");
}

void loop() {
  serviceSerialInput();

  unsigned long nowMs = millis();
  if ((nowMs - lastSampleAt) >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = nowMs;
    readSensorsAndComputeBlend();
    updateLowBlendReminder(nowMs);
    updateMotors(nowMs);
    emitSensorFrame();
  } else {
    updateMotors(nowMs);
  }
}
