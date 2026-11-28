import { appendFileSync } from "node:fs";

export default {
  id: "cleanup-probe",
  setup() {
    const file = process.env.CLEANUP_PROBE_OUT;
    if (!file) throw new Error("CLEANUP_PROBE_OUT is required");
    const record = (value: string) => appendFileSync(file, `${value}\n`);
    record("setup");
    return async () => {
      record("cleanup-start");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      record("cleanup-end");
    };
  },
};
