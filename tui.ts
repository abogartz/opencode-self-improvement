// Convenience re-export for the loose plugin-discovery layout
// (<config>/plugins/<name>/index.ts + tui.ts). Package installs resolve
// "./tui" through package.json exports to the OpenCode adapter's panel directly.
export { default } from "./src/adapters/opencode/tui/panel.tsx";
