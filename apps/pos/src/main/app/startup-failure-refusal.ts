/**
 * RT-1324 (RT-1125 R-39) — operator-facing text for a till that cannot start.
 *
 * Shown in a native error dialog before any window exists, then the app exits.
 * Shape (UX-12.9): what happened, what is safe, what to do, then the evidence
 * support needs on lines of their own (machine text inside an Arabic sentence
 * scrambles in the LTR native dialog, so it never shares a line with Arabic).
 *
 * The copy never offers a reset, restore, reinstall or re-pair: the database
 * holds the pairing and the sealed device token, and unsynced sales. Restoring
 * a snapshot stays a support action (`db/pre-migration-snapshot.ts`).
 *
 * The support lines are English machine labels, as in the schema-ahead and
 * cashier-profile refusals; UX-12.3 (one locale at a time) is flagged on the PR.
 */

export const STARTUP_FAILURE_CLASSES = [
  'database_open',
  'database_migration',
  'disk_full',
  'secret_store',
  'unknown',
] as const;

export type StartupFailureClass = (typeof STARTUP_FAILURE_CLASSES)[number];

export interface StartupFailure {
  failureClass: StartupFailureClass;
  /** A plain SQLite or OS error code (`SQLITE_FULL`, `ENOSPC`), when known. */
  code: string | undefined;
}

export interface StartupRefusal {
  title: string;
  body: string;
}

export interface DescribeStartupFailureInput {
  failure: StartupFailure;
  /** `<userData>/backups`, or undefined when the folder could not be resolved. */
  backupsDir: string | undefined;
}

/**
 * Right-to-left mark. The native dialog lays each paragraph out LTR, so a
 * trailing RLM keeps an Arabic line's sentence-final "." inside the RTL run.
 */
const RLM = '‏';

/**
 * Every class carries this: the files hold unsynced sales (the `-wal` file
 * holds committed sales not yet checkpointed), the pairing and the backups. A
 * cashier freeing disk space must not delete them.
 */
export const DO_NOT_DELETE = 'لا تحذف ملفات نقطة البيع ولا تُلغِ ربط الجهاز.';

const CALL_ADMIN = `اتصل بمسؤول النظام. ${DO_NOT_DELETE}`;

/** What happened, then what to do, per class. */
const CLASS_COPY: Readonly<Record<StartupFailureClass, { what: string; action: string }>> = {
  database_open: {
    what: 'تعذّر فتح قاعدة بيانات هذا الجهاز.',
    action: `أعد تشغيل الجهاز ثم افتح نقطة البيع. إن تكرر ذلك ف${CALL_ADMIN}`,
  },
  database_migration: {
    what: 'تعذّر تحديث قاعدة بيانات هذا الجهاز إلى هذا الإصدار من نقطة البيع.',
    action: CALL_ADMIN,
  },
  disk_full: {
    what: 'لا توجد مساحة كافية على قرص هذا الجهاز لتشغيل نقطة البيع.',
    action: `اتصل بمسؤول النظام لتحرير مساحة على القرص. ${DO_NOT_DELETE}`,
  },
  secret_store: {
    what: 'التخزين الآمن لنظام التشغيل غير متاح على هذا الجهاز، ولا تعمل نقطة البيع بدونه.',
    action: CALL_ADMIN,
  },
  unknown: {
    what: 'حدث خطأ أثناء بدء تشغيل نقطة البيع.',
    action: CALL_ADMIN,
  },
};

/**
 * What is safe, true for every class: this refusal never restores, resets or
 * unpairs anything. (Not "nothing was deleted or changed": a failed upgrade can
 * leave earlier migrations applied and older snapshots pruned.)
 */
const SAFETY = 'لن تُجري نقطة البيع أي استعادة أو إعادة ضبط تلقائية لبيانات هذا الجهاز.';

/** Conditional: a snapshot exists only if an upgrade wrote one (UX-12.13). */
const BACKUPS_HINT =
  'إن حُفظت نسخة احتياطية قبل تحديث قاعدة البيانات، فهي في المجلد المذكور أدناه.';

export function describeStartupFailureRefusal(input: DescribeStartupFailureInput): StartupRefusal {
  const { failure, backupsDir } = input;
  const copy = CLASS_COPY[failure.failureClass];
  const code = failure.code === undefined ? '' : ` (${failure.code})`;
  const lines = [`${copy.what}${RLM}`, `${SAFETY}${RLM}`, `${copy.action}${RLM}`];
  if (backupsDir !== undefined) lines.push(`${BACKUPS_HINT}${RLM}`);
  lines.push('', `Startup failure: ${failure.failureClass}${code}`);
  if (backupsDir !== undefined) lines.push(`Backups folder: ${backupsDir}`);
  return { title: 'تعذّر تشغيل نقطة البيع', body: lines.join('\n') };
}
