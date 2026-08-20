// --- ХРАНИЛИЩЕ ---
// Единая точка сохранения: QuotaExceededError на localStorage.setItem
// (переполненное хранилище) не должна прерывать обработчик, вызвавший
// сохранение (issue #7) — иначе, например, triggerCalculation() после
// setItem в обработчике input просто не выполнится. Не защищает от отказа
// localStorage.getItem (например, в некоторых приватных режимах, где сам
// объект storage недоступен) — те вызовы остаются незащищёнными, это
// известное ограничение, а не часть этой задачи.
let storageErrorShown = false;
function persistText(text) {
  try {
    localStorage.setItem(STORAGE_KEY, text);
    storageErrorShown = false;
    return true;
  } catch (error) {
    console.error('localStorage.setItem failed:', error);
    if (!storageErrorShown) {
      storageErrorShown = true;
      showTooltip('Не удалось сохранить — не хватает места в хранилище');
    }
    return false;
  }
}

// Однократная миграция со старого общего ключа на неймспейсированный —
// иначе уже сохранённый текст пользователя пропал бы при обновлении (issue #3).
// Возвращает сохранённый (уже мигрированный) текст, готовый к показу в редакторе.
function loadStoredText() {
  if (localStorage.getItem(STORAGE_KEY) === null) {
    const legacyText = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyText !== null) {
      // removeItem только при успешной записи — иначе при отказе (например,
      // переполненное хранилище на большом мигрируемом тексте) старый ключ
      // будет стёрт, а новый не создан, и текст пропадёт из обоих (issue #7).
      if (persistText(legacyText)) localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }
  return localStorage.getItem(STORAGE_KEY) || "";
}
