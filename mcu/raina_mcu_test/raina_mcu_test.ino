#include <stdlib.h>
#include <string.h>

/*
  raina_mcu_test.ino
  联调和标定版固件。
*/

const unsigned long SERIAL_BAUD = 115200UL;
const unsigned long SAMPLE_INTERVAL_MS = 33UL;

const byte SENSOR_COUNT = 4;
const byte FILTER_WINDOW = 5;
const byte SENSOR_PINS[SENSOR_COUNT] = {A0, A1, A2, A3};

const byte MOTOR_LEFT_PIN = 5;
const byte MOTOR_RIGHT_PIN = 6;

bool motorActiveLow = true;

const float DEFAULT_WEIGHT_CHEST = 0.60f;
const float DEFAULT_WEIGHT_WAIST = 0.40f;
const float DEFAULT_THRESHOLD = 300.0f;

const unsigned int BASELINE_WINDOW_SAMPLES = 90;

const unsigned long BREATH_CYCLE_MS = 10000UL;
const unsigned long INHALE_MS = 4000UL;

const byte MOTOR_PREPULSE_PWM = 200;
const byte MOTOR_INHALE_PWM = 165;

const unsigned long PREPULSE_ON_MS = 50UL;
const unsigned long PREPULSE_GAP_MS = 50UL;
const byte PREPULSE_COUNT = 3;
const unsigned long PREPULSE_TOTAL_MS =
  (PREPULSE_COUNT * PREPULSE_ON_MS) + ((PREPULSE_COUNT - 1) * PREPULSE_GAP_MS);

struct SensorFilter {
  int samples[FILTER_WINDOW];
  long sum;
  byte index;
  bool filled;
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

bool streamEnabled = true;
bool motorsEnabled = true;
bool patternEnabled = false;

byte manualLeftPwm = 0;
byte manualRightPwm = 0;

unsigned long lastSampleAt = 0UL;
unsigned long patternSinceMs = 0UL;

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

  if (motorActiveLow) {
    analogWrite(pin, 255 - duty);
  } else {
    analogWrite(pin, duty);
  }
}

void stopAllMotors() {
  setMotorPwm(MOTOR_LEFT_PIN, 0);
  setMotorPwm(MOTOR_RIGHT_PIN, 0);
}

void emitCommentLine(const char *message) {
  Serial.print("# ");
  Serial.println(message);
}

void emitHelp() {
  emitCommentLine("HELP");
  emitCommentLine("STATUS");
  emitCommentLine("STREAM_ON");
  emitCommentLine("STREAM_OFF");
  emitCommentLine("CAPTURE_BASELINE");
  emitCommentLine("THRESHOLD:x");
  emitCommentLine("WEIGHT:x,y");
  emitCommentLine("MOTOR_ON");
  emitCommentLine("MOTOR_OFF");
  emitCommentLine("MOTOR_LEFT:0-255");
  emitCommentLine("MOTOR_RIGHT:0-255");
  emitCommentLine("MOTOR_BOTH:0-255");
  emitCommentLine("MOTOR_STOP");
  emitCommentLine("MOTOR_PULSE");
  emitCommentLine("PATTERN_ON");
  emitCommentLine("PATTERN_OFF");
  emitCommentLine("POLARITY:LOW");
  emitCommentLine("POLARITY:HIGH");
  emitCommentLine("RESET");
}

void emitStatusLine() {
  Serial.print("# STATUS baseline=");
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
  Serial.print(" polarity=");
  Serial.print(motorActiveLow ? "LOW" : "HIGH");
  Serial.print(" stream=");
  Serial.print(streamEnabled ? "ON" : "OFF");
  Serial.print(" pattern=");
  Serial.print(patternEnabled ? "ON" : "OFF");
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

void runPulseOnce() {
  setMotorPwm(MOTOR_LEFT_PIN, MOTOR_PREPULSE_PWM);
  setMotorPwm(MOTOR_RIGHT_PIN, MOTOR_PREPULSE_PWM);
  delay(60);
  stopAllMotors();
}

byte patternPwm(unsigned long nowMs) {
  unsigned long elapsed = nowMs - patternSinceMs;
  unsigned long cycleMs = elapsed % BREATH_CYCLE_MS;

  if (cycleMs < PREPULSE_TOTAL_MS) {
    unsigned long chunk = PREPULSE_ON_MS + PREPULSE_GAP_MS;
    unsigned long pulseIndex = cycleMs / chunk;
    if (pulseIndex < PREPULSE_COUNT) {
      unsigned long pulseOffset = cycleMs % chunk;
      if (pulseOffset < PREPULSE_ON_MS) {
        return MOTOR_PREPULSE_PWM;
      }
    }
    return 0;
  }

  if (cycleMs < INHALE_MS) {
    return MOTOR_INHALE_PWM;
  }

  return 0;
}

void updateMotors(unsigned long nowMs) {
  if (!motorsEnabled) {
    stopAllMotors();
    return;
  }

  if (manualLeftPwm > 0 || manualRightPwm > 0) {
    setMotorPwm(MOTOR_LEFT_PIN, manualLeftPwm);
    setMotorPwm(MOTOR_RIGHT_PIN, manualRightPwm);
    return;
  }

  if (patternEnabled) {
    byte pwm = patternPwm(nowMs);
    setMotorPwm(MOTOR_LEFT_PIN, pwm);
    setMotorPwm(MOTOR_RIGHT_PIN, pwm);
    return;
  }

  stopAllMotors();
}

void resetTestState() {
  streamEnabled = true;
  motorsEnabled = true;
  patternEnabled = false;
  manualLeftPwm = 0;
  manualRightPwm = 0;
  weightChest = DEFAULT_WEIGHT_CHEST;
  weightWaist = DEFAULT_WEIGHT_WAIST;
  thresholdValue = DEFAULT_THRESHOLD;
  motorActiveLow = true;
  clearBaselineHistory();
  stopAllMotors();
  emitCommentLine("RESET");
}

void handleCommand(const char *command) {
  if (strcmp(command, "HELP") == 0) {
    emitHelp();
    return;
  }

  if (strcmp(command, "STATUS") == 0) {
    emitStatusLine();
    return;
  }

  if (strcmp(command, "STREAM_ON") == 0) {
    streamEnabled = true;
    emitCommentLine("STREAM_ON");
    return;
  }

  if (strcmp(command, "STREAM_OFF") == 0) {
    streamEnabled = false;
    emitCommentLine("STREAM_OFF");
    return;
  }

  if (strcmp(command, "CAPTURE_BASELINE") == 0) {
    freezeBaselineFromRollingWindow();
    emitCommentLine("BASELINE_CAPTURED");
    return;
  }

  if (strcmp(command, "MOTOR_ON") == 0) {
    motorsEnabled = true;
    emitCommentLine("MOTOR_ON");
    return;
  }

  if (strcmp(command, "MOTOR_OFF") == 0) {
    motorsEnabled = false;
    stopAllMotors();
    emitCommentLine("MOTOR_OFF");
    return;
  }

  if (strcmp(command, "MOTOR_STOP") == 0) {
    manualLeftPwm = 0;
    manualRightPwm = 0;
    patternEnabled = false;
    stopAllMotors();
    emitCommentLine("MOTOR_STOP");
    return;
  }

  if (strcmp(command, "MOTOR_PULSE") == 0) {
    runPulseOnce();
    emitCommentLine("MOTOR_PULSE");
    return;
  }

  if (strcmp(command, "PATTERN_ON") == 0) {
    patternEnabled = true;
    manualLeftPwm = 0;
    manualRightPwm = 0;
    patternSinceMs = millis();
    emitCommentLine("PATTERN_ON");
    return;
  }

  if (strcmp(command, "PATTERN_OFF") == 0) {
    patternEnabled = false;
    stopAllMotors();
    emitCommentLine("PATTERN_OFF");
    return;
  }

  if (strcmp(command, "RESET") == 0) {
    resetTestState();
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

  if (strncmp(command, "MOTOR_LEFT:", 11) == 0) {
    manualLeftPwm = (byte)constrain(atoi(command + 11), 0, 255);
    manualRightPwm = 0;
    patternEnabled = false;
    emitCommentLine("MOTOR_LEFT_SET");
    return;
  }

  if (strncmp(command, "MOTOR_RIGHT:", 12) == 0) {
    manualRightPwm = (byte)constrain(atoi(command + 12), 0, 255);
    manualLeftPwm = 0;
    patternEnabled = false;
    emitCommentLine("MOTOR_RIGHT_SET");
    return;
  }

  if (strncmp(command, "MOTOR_BOTH:", 11) == 0) {
    byte pwm = (byte)constrain(atoi(command + 11), 0, 255);
    manualLeftPwm = pwm;
    manualRightPwm = pwm;
    patternEnabled = false;
    emitCommentLine("MOTOR_BOTH_SET");
    return;
  }

  if (strcmp(command, "POLARITY:LOW") == 0) {
    motorActiveLow = true;
    stopAllMotors();
    emitCommentLine("POLARITY_LOW");
    return;
  }

  if (strcmp(command, "POLARITY:HIGH") == 0) {
    motorActiveLow = false;
    stopAllMotors();
    emitCommentLine("POLARITY_HIGH");
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

void readSensorsAndComputeValues() {
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
  currentAdjustedScore = currentRawScore - frozenBaseline;
  if (currentAdjustedScore < 0.0f) {
    currentAdjustedScore = 0.0f;
  }
  currentBlend = scoreToBlendByte(currentAdjustedScore);

  if (streamEnabled) {
    Serial.print("S1:");
    Serial.print(filteredSensors[0]);
    Serial.print(",S2:");
    Serial.print(filteredSensors[1]);
    Serial.print(",S3:");
    Serial.print(filteredSensors[2]);
    Serial.print(",S4:");
    Serial.print(filteredSensors[3]);
    Serial.print(",CHEST:");
    Serial.print(chestCorrection);
    Serial.print(",WAIST:");
    Serial.print(waistCorrection);
    Serial.print(",RAW:");
    Serial.print(currentRawScore, 2);
    Serial.print(",BASE:");
    Serial.print(frozenBaseline, 2);
    Serial.print(",ADJ:");
    Serial.print(currentAdjustedScore, 2);
    Serial.print(",B:");
    Serial.println(currentBlend);
  }
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
  emitCommentLine("RAINA_MCU_TEST_READY");
  emitHelp();
}

void loop() {
  serviceSerialInput();

  unsigned long nowMs = millis();
  if ((nowMs - lastSampleAt) >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = nowMs;
    readSensorsAndComputeValues();
  }

  updateMotors(nowMs);
}
