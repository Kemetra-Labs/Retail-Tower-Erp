/**
 * RT-1213: the two UUID shapes the API validates. `UUID_RE` is lower case only (the form the
 * cursor and projection code stores and compares); `UUID_RE_I` also accepts upper case. Neither
 * checks the version or variant nibbles. A call site picks the one that matches what it accepted
 * before: changing it changes which request ids are refused.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const UUID_RE_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
