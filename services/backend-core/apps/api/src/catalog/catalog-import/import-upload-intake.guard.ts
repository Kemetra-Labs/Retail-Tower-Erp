/**
 * RT-1505 (spec 049 §8.4, §8.5): the intake of `consoleUploadCatalogImport`,
 * the part of the contract's order of checks that has to run BEFORE the shared
 * idempotency interceptor and the handler:
 *
 *   (2) the `Idempotency-Key` format (400 `idempotency_key_required` /
 *       `idempotency_key_malformed`);
 *   (3) the query (400 `validation_error`), then a free upload slot (429, body
 *       unread), then the body: 413 `file_too_large` past 5 MiB while reading,
 *       400 when empty;
 *   then the SHA-256 of the bytes.
 *
 * It is the LAST guard of the route, so the session, `Origin`, tenant and role
 * guards (all on headers and the cookie) have already passed and a refused
 * caller never has a body read or a slot taken (RT-1295). The raw body comes
 * through `importUploadPassthrough`, registered before the body parsers.
 *
 * The idempotency interceptor fingerprints `req.body`. A raw body has no parsed
 * body, so every file sent under one key would share one fingerprint and a
 * different file would replay the first batch (spec 049 §8.4). This guard
 * therefore sets `req.body` to the fingerprint the spec defines: the file's
 * SHA-256 and the canonical query (`import-upload.query.ts`), and hands the
 * bytes to the handler on `req.importUpload`. The interceptor then replays the
 * same key + bytes + query, and answers `409 idempotency_key_conflict` for the
 * same key with other bytes or any other query value, with no change to it.
 */
import { createHash } from "node:crypto";

import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { readRawBody } from "../../common/raw-body";
import { MAX_FILE_BYTES } from "./catalog-import.limits";
import type { ImportUpload } from "./catalog-import.service";
import {
  IMPORT_UPLOAD_GATE,
  IMPORT_UPLOAD_RETRY_AFTER_SECONDS,
  type ImportUploadGate,
} from "./import-upload.gate";
import { canonicalQuery, UploadQuerySchema } from "./import-upload.query";

/** `POST /api/v1/catalog/imports`, case-insensitive with an optional trailing slash, as Express routing is. */
const UPLOAD_PATH_RE = /^\/api\/v1\/catalog\/imports\/?$/i;

/** The same pattern as the contract's `IdempotencyKey`: 16 to 128 printable ASCII characters, no whitespace. */
const KEY_RE = /^[\x21-\x7E]{16,128}$/;

/** A request the intake has read: the upload for the handler. */
export type ImportUploadRequest = Request & { importUpload?: ImportUpload };

/** Express middleware: keep the global body parsers off the upload route (registered before them, as `logoUploadPassthrough`). */
export function importUploadPassthrough(req: Request, _res: Response, next: () => void): void {
  if (req.method === "POST" && UPLOAD_PATH_RE.test(req.path)) req.headers["content-type"] = "application/octet-stream";
  next();
}

function checkKey(req: Request): void {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key === undefined || key === "") {
    throw new BadRequestException({ code: "idempotency_key_required", message: "This endpoint requires an Idempotency-Key header." });
  }
  if (!KEY_RE.test(key)) {
    throw new BadRequestException({
      code: "idempotency_key_malformed",
      message: "Idempotency-Key must be 16 to 128 printable ASCII characters with no whitespace.",
    });
  }
}

/** The retryable capacity refusal: no body was read, the connection closes, the caller retries. */
function busy(res: Response): HttpException {
  res.setHeader("Retry-After", String(IMPORT_UPLOAD_RETRY_AFTER_SECONDS));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
  return new HttpException({ code: "rate_limited", message: "Too many imports are being received. Retry shortly." }, 429);
}

@Injectable()
export class ImportUploadIntakeGuard implements CanActivate {
  constructor(@Inject(IMPORT_UPLOAD_GATE) private readonly gate: ImportUploadGate) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<ImportUploadRequest>();
    const res = http.getResponse<Response>();
    checkKey(req);
    const query = UploadQuerySchema.parse(req.query);
    const release = this.gate.tryAcquire();
    if (release === null) throw busy(res);
    // The slot is held until the response is done (or the connection drops), parse and write included.
    res.once("finish", release);
    res.once("close", release);
    const bytes = await readRawBody(req, {
      maxBytes: MAX_FILE_BYTES,
      tooLargeMessage: "The file is larger than 5 MiB.",
      unwiredMessage: "import upload body was consumed by a body parser (importUploadPassthrough not wired)",
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    req.importUpload = { bytes, sha256, query };
    req.body = { fileSha256: sha256, query: canonicalQuery(query) };
    return true;
  }
}
