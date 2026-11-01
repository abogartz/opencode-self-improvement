// Convenience re-export for the loose plugin-discovery layout
// (<config>/plugins/<name>/index.ts + tui.ts). Package installs resolve
// "./tui" through package.json exports to src/tui.tsx directly.
export { default } from "./src/tui/panel.tsx";
