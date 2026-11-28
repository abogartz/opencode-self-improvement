import { createPiCapture } from "../pi-family/capture.ts";
export type { PiCaptureBinding as OmpCaptureBinding } from "../pi-family/capture.ts";
export const createOhMyPiCapture = () => createPiCapture("oh-my-pi");
