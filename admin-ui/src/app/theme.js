const STORAGE_KEY = "aoai-admin-ui-theme";
export const themes = ["system", "light", "dark"];

export function initializeTheme() {
  let stored;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    if (error.name !== "SecurityError") throw error;
    console.warn("Theme preference storage is unavailable; using the system theme.", error);
  }
  const theme = themes.includes(stored) ? stored : "system";
  applyTheme(theme);
  return theme;
}

export function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme) {
  window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}
