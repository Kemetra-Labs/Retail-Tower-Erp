# Copyright (c) 2026, Retail Tower OS and contributors
# For license information, please see license.txt

"""RT-1359 — site-side operations that can be checked without a site, against a minimal frappe
stand-in: the replacement Administrator password (OD-9) is random, used by nothing else and appears
in no output; the no-commit switch the bench-lane test relies on."""

import json
import logging
import sys
import types

import pytest

from retail_tower_erpnext_connector.provisioner import site_ops


class _Flags(dict):
	pass


@pytest.fixture
def stub(monkeypatch):
	state = types.SimpleNamespace(passwords=[], commits=0)
	frappe = types.ModuleType("frappe")
	frappe.flags = _Flags()
	frappe.db = types.SimpleNamespace(commit=lambda: setattr(state, "commits", state.commits + 1))
	utils = types.ModuleType("frappe.utils")
	password = types.ModuleType("frappe.utils.password")

	def update_password(user, pwd, logout_all_sessions=False):
		state.passwords.append((user, pwd, logout_all_sessions))

	password.update_password = update_password
	frappe.utils = utils
	utils.password = password
	monkeypatch.setitem(sys.modules, "frappe", frappe)
	monkeypatch.setitem(sys.modules, "frappe.utils", utils)
	monkeypatch.setitem(sys.modules, "frappe.utils.password", password)
	state.frappe = frappe
	return state


def test_the_replacement_admin_password_is_random_single_use_and_in_no_output(stub, capsys, caplog):
	caplog.set_level(logging.DEBUG)
	first = site_ops.run({"op": "reset_admin_password"})
	second = site_ops.run({"op": "reset_admin_password"})
	(user1, pw1, logout1), (_, pw2, _) = stub.passwords
	assert user1 == "Administrator" and logout1 is True  # every session of the throwaway value ends
	assert pw1 != pw2 and len(pw1) >= 32
	out = capsys.readouterr()
	recorded = " ".join([json.dumps(first), json.dumps(second), out.out, out.err, caplog.text])
	assert pw1 not in recorded and pw2 not in recorded
	assert first == {"ok": True}


def test_nothing_is_committed_when_the_caller_runs_its_own_transaction(stub):
	site_ops._commit()
	assert stub.commits == 1
	stub.frappe.flags["rt_provisioner_no_commit"] = True
	site_ops._commit()
	assert stub.commits == 1


def test_an_unknown_operation_is_rejected():
	with pytest.raises(site_ops.OpError):
		site_ops.run({"op": "drop_everything"})
