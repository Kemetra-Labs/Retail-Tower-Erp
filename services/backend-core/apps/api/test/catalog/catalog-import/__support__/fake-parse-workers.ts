/** RT-1535: stand-in worker entries for the off-thread parse tests. Each is run as a worker file. */
import { parentPort, workerData } from "node:worker_threads";

// The mode rides in the job's `sheet` option (a Jest sandbox's process.env does not reach a worker thread).
const mode = (workerData as { job: { options: { sheet: string | null } } }).job.options.sheet;
if (parentPort !== null) {
  if (mode === "crash") process.exit(3);
  else if (mode === "silent-exit") process.exit(0);
  else if (mode === "unexpected") parentPort.postMessage({ ok: false, unexpected: "TypeError: boom" });
  // any other mode never answers: the host's timeout ends it
  else setInterval(() => undefined, 1000);
}
