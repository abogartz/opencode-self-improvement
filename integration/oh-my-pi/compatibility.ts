import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import extension from "../../src/adapters/oh-my-pi/extension.ts";

// Compile against the pinned host; production keeps this optional SDK out.
export default extension satisfies ExtensionFactory;
