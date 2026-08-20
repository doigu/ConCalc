// --- ПРОВЕРКА ОБНОВЛЕНИЯ ---
// registration.update() не годится: service-worker.js между релизами
// байт-в-байт одинаков (версия приходит параметром ?v= из URL регистрации,
// а не из содержимого файла), поэтому штатный updatefound не срабатывает —
// сравнивать нечего (issue #12). Вместо этого сверяем APP_VERSION в текущем
// config.js на сервере с уже загруженным. Триггеры — только запуск и возврат
// видимости вкладки спустя более часа с прошлой проверки; фонового опроса
// нет, чтобы не будить постоянно открытую вкладку зря.
let lastUpdateCheck = 0;
let updateAvailable = false;

function checkForUpdate() {
  if (updateAvailable) return;
  lastUpdateCheck = Date.now();
  fetch('config.js', { cache: 'no-store' })
    .then(response => response.text())
    .then(text => {
      const match = text.match(/const APP_VERSION = '([^']+)'/);
      if (match && match[1] !== APP_VERSION) {
        updateAvailable = true;
        updateBtn.hidden = false;
      }
    })
    .catch(() => {}); // офлайн, таймаут и т. п. — тихо, следующая проверка повторит
}

updateBtn.addEventListener('click', () => showTooltip(UPDATE_MESSAGE, UPDATE_MESSAGE_DURATION));
