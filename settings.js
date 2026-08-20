// --- НАСТРОЙКИ ДИАЛОГА (issue #10) ---
// Ключ хранилища и значения по умолчанию — в config.js. currentSettings —
// единственный источник правды в главном потоке; сам воркер настроек не
// хранит, получает их каждым запросом (buildRequest в calc.js, поле
// options.format в parser.js), поэтому смена настройки не требует
// перезапуска воркера и подхватывается следующим же пересчётом.

let currentSettings = null;

function clampInt(value, limits, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(n)));
}

// Каждое поле валидируется отдельно — битое значение одного поля (сторонний
// JSON, ручная правка localStorage) не должно ронять остальные или сам
// запуск, тот же принцип, что persistText/loadStoredText для текста (issue #7).
// calcPrecision валидируется первым — precision и decimals не могут
// превышать точность самих вычислений.
function sanitizeSettings(raw) {
  raw = (raw && typeof raw === 'object') ? raw : {};
  const s = {};

  s.calcPrecision = clampInt(raw.calcPrecision, SETTINGS_LIMITS.calcPrecision, DEFAULT_SETTINGS.calcPrecision);

  const precisionLimit = { min: SETTINGS_LIMITS.precision.min, max: s.calcPrecision };
  s.precision = clampInt(raw.precision, precisionLimit, Math.min(DEFAULT_SETTINGS.precision, s.calcPrecision));

  s.lowerExp = clampInt(raw.lowerExp, SETTINGS_LIMITS.lowerExp, DEFAULT_SETTINGS.lowerExp);
  s.upperExp = clampInt(raw.upperExp, SETTINGS_LIMITS.upperExp, DEFAULT_SETTINGS.upperExp);

  const decimalsLimit = { min: SETTINGS_LIMITS.decimals.min, max: s.calcPrecision };
  s.decimals = (raw.decimals === null) ? null : clampInt(raw.decimals, decimalsLimit, DEFAULT_SETTINGS.decimals);

  s.grouping = raw.grouping === true;
  s.groupSeparator = GROUP_SEPARATOR_OPTIONS.indexOf(raw.groupSeparator) !== -1
    ? raw.groupSeparator : DEFAULT_SETTINGS.groupSeparator;

  return s;
}

// Единая точка сохранения настроек — тот же приём, что persistText в
// storage.js: QuotaExceededError не должна прерывать вызвавший обработчик
// (issue #7), но это отдельный ключ и отдельный тултип, ключ текста и его
// сбои с настройками не смешиваются.
let settingsErrorShown = false;
function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    settingsErrorShown = false;
    return true;
  } catch (error) {
    console.error('localStorage.setItem (settings) failed:', error);
    if (!settingsErrorShown) {
      settingsErrorShown = true;
      showTooltip('Не удалось сохранить настройки');
    }
    return false;
  }
}

// Ключа раньше не существовало — его отсутствие само по себе означает
// значения по умолчанию, миграции нет.
function loadSettings() {
  let raw = null;
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored !== null) raw = JSON.parse(stored);
  } catch (e) {
    raw = null; // не JSON — sanitizeSettings(null) подставит умолчания
  }
  return sanitizeSettings(raw);
}

currentSettings = loadSettings();

// Единственный путь изменения currentSettings — иначе в одном из мест
// диалога легко забыть persistText/triggerCalculation. Пересчёт запускается
// всегда: без него текст не меняется, и новый формат появился бы только
// после следующего нажатия клавиши, а не сразу.
function updateSetting(key, value) {
  const next = Object.assign({}, currentSettings);
  next[key] = value;
  currentSettings = sanitizeSettings(next);
  saveSettings(currentSettings);
  triggerCalculation();
  return currentSettings;
}

function resetSettings() {
  currentSettings = sanitizeSettings({});
  saveSettings(currentSettings);
  triggerCalculation();
  return currentSettings;
}

// --- ДИАЛОГ ---
const settingsBtn = document.getElementById('settings-btn');
const settingsDialog = document.getElementById('settings-dialog');
const groupingInput = document.getElementById('setting-grouping');
const groupSeparatorInput = document.getElementById('setting-group-separator');
const decimalsInput = document.getElementById('setting-decimals');
const decimalsUnlimitedInput = document.getElementById('setting-decimals-unlimited');
const precisionInput = document.getElementById('setting-precision');
const lowerExpInput = document.getElementById('setting-lower-exp');
const upperExpInput = document.getElementById('setting-upper-exp');
const calcPrecisionInput = document.getElementById('setting-calc-precision');
const settingsResetBtn = document.getElementById('settings-reset-btn');

// Отражает currentSettings в поля формы. Вызывается при открытии диалога и
// после «По умолчанию» — состояние формы никогда не редактируется само по
// себе, только перечитывается из currentSettings.
function renderSettingsForm() {
  groupingInput.checked = currentSettings.grouping;
  groupSeparatorInput.value = currentSettings.groupSeparator;

  const unlimited = currentSettings.decimals === null;
  decimalsUnlimitedInput.checked = unlimited;
  decimalsInput.disabled = unlimited;
  decimalsInput.value = unlimited ? DEFAULT_SETTINGS.decimals : currentSettings.decimals;
  decimalsInput.max = currentSettings.calcPrecision;

  precisionInput.value = currentSettings.precision;
  precisionInput.max = currentSettings.calcPrecision;

  lowerExpInput.value = currentSettings.lowerExp;
  upperExpInput.value = currentSettings.upperExp;
  calcPrecisionInput.value = currentSettings.calcPrecision;
}

function openSettingsDialog() {
  renderSettingsForm();
  // Chrome сам восстанавливает фокус на элементе, который был в фокусе на
  // момент showModal() — эта встроенная фиксация происходит ПОСЛЕ события
  // close и перекрывает любой editor.focus(), поставленный в его
  // обработчике (проверено: ни синхронный вызов, ни setTimeout, ни двойной
  // requestAnimationFrame внутри close не переживают эту фиксацию, если
  // «элементом на момент showModal()» была settings-btn — клик по кнопке
  // сам ставит на неё фокус). Решение — не бороться со встроенной фиксацией,
  // а сделать её целью editor: фокус переносится в текст ДО showModal(),
  // тогда закрытие диалога само возвращает фокус куда нужно, без обработчика
  // close вообще.
  editor.focus();
  settingsDialog.showModal();
}

function closeSettingsDialog() {
  if (settingsDialog.open) settingsDialog.close();
}

function toggleSettingsDialog() {
  if (settingsDialog.open) closeSettingsDialog(); else openSettingsDialog();
}

settingsBtn.onclick = openSettingsDialog;

groupingInput.addEventListener('change', () => {
  updateSetting('grouping', groupingInput.checked);
});
groupSeparatorInput.addEventListener('change', () => {
  updateSetting('groupSeparator', groupSeparatorInput.value);
});
decimalsUnlimitedInput.addEventListener('change', () => {
  updateSetting('decimals', decimalsUnlimitedInput.checked ? null : Number(decimalsInput.value));
  renderSettingsForm();
});
decimalsInput.addEventListener('change', () => {
  updateSetting('decimals', Number(decimalsInput.value));
});
precisionInput.addEventListener('change', () => {
  updateSetting('precision', Number(precisionInput.value));
});
lowerExpInput.addEventListener('change', () => {
  updateSetting('lowerExp', Number(lowerExpInput.value));
});
upperExpInput.addEventListener('change', () => {
  updateSetting('upperExp', Number(upperExpInput.value));
});
calcPrecisionInput.addEventListener('change', () => {
  updateSetting('calcPrecision', Number(calcPrecisionInput.value));
  renderSettingsForm(); // precision/decimals могли зажаться под новый calcPrecision
});

settingsResetBtn.addEventListener('click', () => {
  resetSettings();
  renderSettingsForm();
});

// --- ГОРЯЧИЕ КЛАВИШИ (используются из KEYMAP в main.js) ---
function toggleGrouping() {
  updateSetting('grouping', !currentSettings.grouping);
  showTooltip(currentSettings.grouping ? 'Разряды включены' : 'Разряды выключены');
}

function setDecimals(n) {
  updateSetting('decimals', n);
  showTooltip('Знаков после запятой: ' + n);
}
