# Copyright (c) 2026, Retail Tower OS and contributors
# For license information, please see license.txt

"""RT-1340 — the fixed promotion give-back Item (owner decision 2026-11-14).

The pure checks (:mod:`posting.give_back_item`) and the install/migrate step that creates the Item
(:func:`connector.schema.ensure_give_back_item`), the latter against a minimal frappe stand-in.
"""

import importlib
import sys
import types

import pytest

from retail_tower_erpnext_connector.connector.posting import give_back_item as gbi
from retail_tower_erpnext_connector.connector.posting.return_builder import (
	GiveBackItem,
	GiveBackItemNotConfigured,
)

_SCHEMA = "retail_tower_erpnext_connector.connector.schema"
_MISSING = object()
_OK = {"disabled": 0, "is_stock_item": 0, "stock_uom": "Nos"}


class TestResolve:
	def test_a_usable_item_resolves_with_its_own_stock_uom(self):
		assert gbi.resolve_give_back_item({**_OK, "stock_uom": "Unit"}) == GiveBackItem(
			"RT-PROMO-GIVEBACK", "Unit"
		)

	@pytest.mark.parametrize(
		("row", "why"),
		[
			(None, "does not exist"),
			({**_OK, "disabled": 1}, "is disabled"),
			({**_OK, "is_stock_item": 1}, "is a stock Item"),
			({**_OK, "stock_uom": None}, "has no stock UOM"),
		],
	)
	def test_an_unusable_item_fails_closed_with_the_reason(self, row, why):
		with pytest.raises(GiveBackItemNotConfigured, match=why):
			gbi.resolve_give_back_item(row)


class _Frappe(types.ModuleType):
	def __init__(self, *, existing=(), insert_error=None):
		super().__init__("frappe")
		self.existing = set(existing)
		self.inserted, self.commits, self.logged = [], 0, []
		self.insert_error = insert_error
		self.db = types.SimpleNamespace(
			exists=lambda doctype, name: (doctype, name) in self.existing, commit=self._commit
		)
		self.logger = lambda name=None: types.SimpleNamespace(error=self.logged.append)

	def _commit(self):
		self.commits += 1

	def get_doc(self, payload):
		fake = self

		class _Doc:
			def insert(self, ignore_permissions=False):
				if fake.insert_error is not None:
					raise fake.insert_error
				fake.inserted.append(payload)

		return _Doc()


@pytest.fixture
def load_schema():
	saved = [(name, sys.modules.get(name, _MISSING)) for name in ("frappe", _SCHEMA)]

	def _load(fake):
		sys.modules["frappe"] = fake
		sys.modules.pop(_SCHEMA, None)
		return importlib.import_module(_SCHEMA)

	yield _load
	for name, value in saved:
		sys.modules.pop(name, None)
		if value is not _MISSING:
			sys.modules[name] = value


_READY = {("Item Group", "All Item Groups"), ("UOM", "Nos")}


class TestEnsureGiveBackItem:
	def test_a_missing_item_is_created_non_stock_and_committed(self, load_schema):
		fake = _Frappe(existing=_READY)
		load_schema(fake).ensure_give_back_item()
		((doc),) = fake.inserted
		assert (doc["doctype"], doc["item_code"], doc["is_stock_item"], doc["stock_uom"]) == (
			"Item",
			"RT-PROMO-GIVEBACK",
			0,
			"Nos",
		)
		assert fake.commits == 1

	def test_an_existing_item_is_never_touched(self, load_schema):
		fake = _Frappe(existing=_READY | {("Item", "RT-PROMO-GIVEBACK")})
		load_schema(fake).ensure_give_back_item()
		assert fake.inserted == [] and fake.commits == 0

	def test_before_the_setup_wizard_it_is_deferred_and_logged(self, load_schema):
		fake = _Frappe(existing=())
		load_schema(fake).ensure_give_back_item()
		assert fake.inserted == []
		assert fake.logged[0]["event"] == "give_back_item.deferred"

	def test_an_insert_failure_never_fails_the_migrate(self, load_schema):
		fake = _Frappe(existing=_READY, insert_error=RuntimeError("Income Account missing"))
		load_schema(fake).ensure_give_back_item()  # no raise
		assert fake.logged[0]["event"] == "give_back_item.ensure_failed"
		assert "RuntimeError: Income Account missing" in fake.logged[0]["detail"]
