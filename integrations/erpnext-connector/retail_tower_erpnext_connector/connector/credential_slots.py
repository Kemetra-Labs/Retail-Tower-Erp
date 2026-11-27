# Copyright (c) 2026, Retail Tower OS and contributors
# For license information, please see license.txt

"""RT-1362 S3 — dual-slot credential staging in Connector Settings (``provisioning-feed.yaml`` 1.2.0-draft,
"Credential rotation", owner decision RT-1362 c19107: OVERLAP).

Connector Settings keep the CURRENT credential (``dp2_token`` and its ids, as before) and at most one
PENDING credential (``dp2_pending_*``). The provisioner writes a rotated credential into the PENDING slot
only (:func:`stage_pending`, a fenced compare-and-set on ``issuedAt``); the shared transport authenticates
with PENDING while it is present, falls back to CURRENT on a refusal and clears nothing, and on the first
accepted call with PENDING promotes it to CURRENT (:func:`promote_pending`). CURRENT is therefore only ever
replaced by a credential Backend-Core has just accepted, so a lost write, a failed rotation or a stale
pending write never stops posting.

The pending ``issuedAt`` and ``expiresAt`` are kept as the ISO-8601 UTC strings Backend-Core sent, so the
fencing compare is made in UTC (a site-local naive Datetime can run backwards across a DST change).

The decision functions are pure. The writes import ``frappe`` on use and go through Frappe's own password
API (``set_encrypted_password`` / ``remove_encrypted_password``) and ``set_single_value``, after a locking
read of the Connector Settings rows: the locking read sees the latest committed values whatever the
caller's transaction saw before, and serialises the provisioner's stage with a poller's promotion. A
secret is never logged, returned or put in an exception.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

SETTINGS = "Connector Settings"
CURRENT_TOKEN = "dp2_token"
CURRENT_ID = "dp2_credential_id"
CURRENT_ISSUED = "dp2_credential_issued_at"
CURRENT_EXPIRES = "dp2_credential_expires_at"
REGISTRATION_ID = "dp2_connector_registration_id"
PENDING_TOKEN = "dp2_pending_token"
PENDING_ID = "dp2_pending_credential_id"
PENDING_ISSUED = "dp2_pending_credential_issued_at"
PENDING_EXPIRES = "dp2_pending_credential_expires_at"
PENDING_FIELDS = (PENDING_TOKEN, PENDING_ID, PENDING_ISSUED, PENDING_EXPIRES)

WRITE = "write"
NOOP = "noop"
STALE = "stale"


@dataclass(frozen=True)
class PendingCredential:
	"""The staged credential as the transport holds it for one tick. The secret is shown nowhere."""

	credential_id: str
	secret: str
	issued_at: str
	expires_at: str

	def __repr__(self) -> str:
		return f"PendingCredential(credential_id={self.credential_id!r}, secret=<redacted>)"

	__str__ = __repr__


def parse_utc(value: object) -> datetime | None:
	"""An aware datetime from an ISO-8601 string, or ``None`` when it is missing, unreadable or naive."""
	if not isinstance(value, str) or not value:
		return None
	try:
		parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
	except ValueError:
		return None
	return parsed if parsed.tzinfo is not None else None


def stage_decision(
	*,
	current_id: str | None,
	pending_id: str | None,
	pending_issued_at: str | None,
	new_id: str,
	new_issued_at: str,
) -> str:
	"""The compare-and-set rule of the pending slot (contract step 4).

	* ``noop``: the credential is already the CURRENT one (promoted), or already staged with the same
	  ``credentialId`` and ``issuedAt`` (a retry after a lost write response).
	* ``stale``: the slot holds a credential with the same or a later ``issuedAt``: a newer worker owns
	  the rotation, so nothing is written.
	* ``write``: the slot is empty, or holds an earlier ``issuedAt`` (or an unreadable one, which can
	  only be damage: the rotation must not stay blocked on it).
	"""
	new_at = parse_utc(new_issued_at)
	if new_at is None:
		raise ValueError("issuedAt is not an ISO-8601 time with a zone")
	if current_id and current_id == new_id:
		return NOOP
	if not pending_id:
		return WRITE
	stored_at = parse_utc(pending_issued_at)
	if pending_id == new_id:
		return NOOP if stored_at == new_at else STALE
	if stored_at is None:
		return WRITE
	return WRITE if stored_at < new_at else STALE


def read_pending(settings) -> PendingCredential | None:
	"""The PENDING slot of a Connector Settings document, or ``None`` when it is empty or unreadable.

	The secret is read only when the non-secret pending id is set, so a document without the slot
	(an older site, a test stand-in) is never asked for it."""
	credential_id = str(getattr(settings, PENDING_ID, "") or "").strip()
	if not credential_id:
		return None
	try:
		secret = settings.get_password(PENDING_TOKEN, raise_exception=False) or ""
	except Exception:  # an unreadable pending secret is the same as none: CURRENT keeps posting
		return None
	if not secret:
		return None
	return PendingCredential(
		credential_id=credential_id,
		secret=secret,
		issued_at=str(getattr(settings, PENDING_ISSUED, "") or ""),
		expires_at=str(getattr(settings, PENDING_EXPIRES, "") or ""),
	)


# --- frappe-backed writes ----------------------------------------------------------------------------


def _locked_values() -> dict:
	"""Every stored value of Connector Settings, by a LOCKING read (the latest committed values; held
	until the caller's transaction ends). Frappe keeps a Single DocType in ``tabSingles``."""
	import frappe

	rows = frappe.db.sql(
		"select field, value from `tabSingles` where doctype=%s for update", (SETTINGS,), as_list=True
	)
	return {field: value for field, value in rows}


def has_pending_slot() -> bool:
	"""True when this site's Connector Settings carry the pending-slot fields (``bench migrate`` ran)."""
	import frappe

	meta = frappe.get_meta(SETTINGS)
	return all(meta.has_field(name) for name in PENDING_FIELDS)


def _site_naive(iso: str):
	from frappe.utils import convert_utc_to_system_timezone, get_datetime

	return convert_utc_to_system_timezone(get_datetime(iso.replace("Z", "+00:00"))).replace(tzinfo=None)


def _dummy(secret: str) -> str:
	"""What a saved Password field shows in ``tabSingles`` (Frappe's own mask), so a later form save
	keeps the encrypted value instead of removing it."""
	return "*" * len(secret)


def stage_pending(
	*, registration_id: str, credential_id: str, issued_at: str, expires_at: str, secret: str
) -> str:
	"""Write a rotated credential into the PENDING slot (never CURRENT), as a compare-and-set.

	Returns ``write``, ``noop`` or ``stale`` (see :func:`stage_decision`). Raises ``LookupError`` when the
	settings name another registration. The caller commits."""
	import frappe
	from frappe.utils.password import set_encrypted_password

	values = _locked_values()
	if (values.get(REGISTRATION_ID) or None) != registration_id:
		raise LookupError("Connector Settings name another registration")
	decision = stage_decision(
		current_id=values.get(CURRENT_ID) or None,
		pending_id=values.get(PENDING_ID) or None,
		pending_issued_at=values.get(PENDING_ISSUED) or None,
		new_id=credential_id,
		new_issued_at=issued_at,
	)
	if decision != WRITE:
		return decision
	set_encrypted_password(SETTINGS, SETTINGS, secret, PENDING_TOKEN)
	frappe.db.set_single_value(
		SETTINGS,
		{
			PENDING_TOKEN: _dummy(secret),
			PENDING_ID: credential_id,
			PENDING_ISSUED: issued_at,
			PENDING_EXPIRES: expires_at,
		},
		update_modified=False,
	)
	return decision


def promote_pending(pending: PendingCredential) -> bool:
	"""Backend-Core accepted ``pending``: make it CURRENT and empty the pending slot, then commit.

	A compare-and-set on the pending credential id under the lock: when the slot now holds another
	credential (a newer rotation staged one, or another job already promoted this one) nothing changes
	and the result is ``False``. The commit is safe where the transport is called: a poller calls
	Backend-Core only once its ERP effects are durable (RT-458), as for the feed-state checkpoint (RT-883).
	"""
	import frappe
	from frappe.utils.password import remove_encrypted_password, set_encrypted_password

	values = _locked_values()
	if (values.get(PENDING_ID) or None) != pending.credential_id:
		return False
	set_encrypted_password(SETTINGS, SETTINGS, pending.secret, CURRENT_TOKEN)
	updates = {
		CURRENT_TOKEN: _dummy(pending.secret),
		CURRENT_ID: pending.credential_id,
		PENDING_TOKEN: None,
		PENDING_ID: None,
		PENDING_ISSUED: None,
		PENDING_EXPIRES: None,
	}
	if parse_utc(pending.issued_at) is not None:
		updates[CURRENT_ISSUED] = _site_naive(pending.issued_at)
	if parse_utc(pending.expires_at) is not None:
		updates[CURRENT_EXPIRES] = _site_naive(pending.expires_at)
	frappe.db.set_single_value(SETTINGS, updates, update_modified=False)
	remove_encrypted_password(SETTINGS, SETTINGS, PENDING_TOKEN)
	frappe.db.commit()
	return True


def reload_current_token() -> str | None:
	"""The CURRENT secret as last committed (a locking read, so another job's promotion is seen even
	when this job's transaction read the settings before it). ``None`` when unset or unreadable."""
	import frappe
	from frappe.utils.password import decrypt

	rows = frappe.db.sql(
		"select `password` from `__Auth` where doctype=%s and name=%s and fieldname=%s and encrypted=1"
		" lock in share mode",
		(SETTINGS, SETTINGS, CURRENT_TOKEN),
	)
	if not rows or not rows[0][0]:
		return None
	return decrypt(rows[0][0]) or None


def slot_ids() -> dict:
	"""The non-secret ids of both slots, as last committed (for the provisioner's checks)."""
	values = _locked_values()
	return {
		"current_credential_id": values.get(CURRENT_ID) or None,
		"pending_credential_id": values.get(PENDING_ID) or None,
		"pending_issued_at": values.get(PENDING_ISSUED) or None,
	}
