// UI rendering: 8-panel HUD, module launcher, console feed, settings.

export function renderMode(root, mode) {
  root.classList.remove("lost", "ghost", "manifested");
  root.classList.add(mode);
}

export function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export function appendLog(logEl, history, entry, level = "INFO") {
  const t = new Date().toLocaleTimeString();
  history.unshift({ t, msg: entry, level });
  logEl.innerHTML = history
    .slice(0, 100)
    .map((x) => `<div><time>${x.t}</time>[${x.level}] ${escapeHtml(x.msg)}</div>`)
    .join("");
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderModuleGrid(container, modules, activeId, onSelect) {
  container.innerHTML = "";
  modules.forEach((m) => {
    const card = document.createElement("div");
    card.className = "module-card" + (m.id === activeId ? " active" : "");
    card.innerHTML = `<b>${escapeHtml(m.name)}</b>${escapeHtml(m.description)}`;
    card.addEventListener("click", () => onSelect(m.id));
    container.appendChild(card);
  });
}

export function severityBadge(severity) {
  return `<span class="severity ${severity}">${severity.toUpperCase()}</span>`;
}
