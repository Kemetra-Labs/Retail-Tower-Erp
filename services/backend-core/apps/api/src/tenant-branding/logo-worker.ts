/**
 * The logo worker thread's entry (RT-1041): one message is one checked PNG,
 * answered with one `LogoReply` (logo-render.ts). The API main thread starts
 * it from logo-pipeline.ts; every pixel of the decode and render runs here.
 */
import { parentPort } from "node:worker_threads";

import { renderReply } from "./logo-render";

const port = parentPort;
if (port === null) throw new Error("logo-worker: must run as a worker thread");
port.on("message", (png: Uint8Array) => {
  void renderReply(png).then((reply) => port.postMessage(reply));
});
