/**
 * RT-855 (RT-699 I2) — the manual discount on the live Sale, through the real
 * workspace and fake bridges: the cashier path on the RT-114 approval, the
 * manager direct path, the refusals where D1 draws them, keyboard and focus,
 * and axe on every new surface.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { ManagerApprovalBridgeAPI } from '../../../shared/operator/manager-approval';
import type { Role } from '../../../shared/operator/role';
import { useScanNoticeStore } from '../../scan/scan-notice-store';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useDiscountDetailsStore } from '../../stores/discount-details-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useLineFlagsStore } from '../../stores/line-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { expectNoAxeViolations } from '../../test-utils/axe-config';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';
import { addLineByScan, makeBridges, type Bridges } from './__helpers__/live-sale-harness';

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useLineFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  useDiscountDetailsStore.getState().reset();
  useScanNoticeStore.setState({ message: null, seq: 0 });
});

const MANAGERS = [
  { approver_ref: 'm-1', display_name: 'سارة عبد الحميد' },
  { approver_ref: 'm-2', display_name: 'خالد إبراهيم' },
];

function approvalBridge(): ManagerApprovalBridgeAPI & {
  listApprovers: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
} {
  return {
    listApprovers: vi.fn().mockResolvedValue({ kind: 'approvers', approvers: MANAGERS }),
    request: vi.fn().mockResolvedValue({ kind: 'approved', approval_id: 'appr-1' }),
  };
}

function signIn(role: Role, displayName: string): void {
  useFeatureFlagsStore.setState({ cart: true, productSearch: true, payments: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: displayName,
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-26T08:00:00Z',
  });
}

interface Sale {
  user: ReturnType<typeof userEvent.setup>;
  bridges: Bridges;
  approval: ReturnType<typeof approvalBridge>;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

/** A signed-in sale with one بنادول line (1 × 15.00 EGP). */
async function saleWithOneLine(role: Role = 'cashier', name = 'منى عادل'): Promise<Sale> {
  signIn(role, name);
  const bridges = makeBridges();
  const approval = approvalBridge();
  const add = vi.fn().mockResolvedValue({
    kind: 'ok',
    placeholder_id: 'dp-1',
    requires_manager_attribution: false,
  });
  const remove = vi.fn().mockResolvedValue({ kind: 'ok' });
  Object.assign(bridges.cart.discountPlaceholders, { add, remove });
  render(
    <LiveSaleWorkspace
      cartBridge={bridges.cart}
      catalogueBridge={bridges.catalogue}
      approvalBridge={approval}
      onPaymentContinue={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await addLineByScan(user);
  return { user, bridges, approval, add, remove };
}

function discountButton(): HTMLElement {
  return screen.getByRole('button', { name: 'خصم' });
}

function sheet(): HTMLElement {
  return screen.getByRole('dialog', { name: 'خصم على الصنف' });
}

async function fillSheet(
  user: Sale['user'],
  value: string,
  reason: string,
  kind?: 'مبلغ ثابت',
): Promise<void> {
  await user.click(discountButton());
  if (kind !== undefined) await user.click(within(sheet()).getByRole('radio', { name: kind }));
  await user.type(within(sheet()).getByRole('textbox', { name: 'قيمة الخصم' }), value);
  await user.click(within(sheet()).getByRole('radio', { name: reason }));
}

async function approveAs(user: Sale['user'], manager: string, pin = '135790'): Promise<void> {
  const prompt = await screen.findByRole('dialog', { name: 'موافقة المدير' });
  await user.click(await within(prompt).findByRole('radio', { name: manager }));
  await user.type(within(prompt).getByLabelText('الرقم السري للمدير'), pin);
  await user.click(within(prompt).getByRole('button', { name: 'اعتماد الخصم' }));
}

function totalsRow(label: string): HTMLElement {
  const row = screen.getByText(label).parentElement;
  if (row === null) throw new Error(`no totals row ${label}`);
  return row;
}

describe('RT-855 cashier path — the RT-114 approval (doc 28 §4.1)', () => {
  it('previews from the shared math, asks a manager, and adds with only the approval id', async () => {
    const { user, approval, add } = await saleWithOneLine();
    expect(discountButton()).toBeEnabled();
    await user.click(discountButton());

    const form = sheet();
    const value = within(form).getByRole('textbox', { name: 'قيمة الخصم' });
    expect(value).toHaveFocus();
    expect(within(form).getByText('يحتاج الخصم موافقة مدير قبل تطبيقه.')).toBeInTheDocument();
    expect(within(form).getByText('1 × 15.00 EGP')).toBeInTheDocument();
    await user.type(value, '10');
    expect(within(form).getByText('الصافي بعد الخصم').nextElementSibling).toHaveTextContent(
      '13.50 EGP',
    );
    // The reason is required on both paths (OD-28-9).
    const commit = within(form).getByRole('button', { name: 'طلب موافقة المدير' });
    expect(commit).toBeDisabled();
    expect(within(form).getByText('اختر سبب الخصم للمتابعة.')).toBeInTheDocument();
    await user.click(within(form).getByRole('radio', { name: 'عرض ترويجي' }));
    expect(commit).toBeEnabled();
    await user.click(commit);

    const prompt = await screen.findByRole('dialog', { name: 'موافقة المدير' });
    expect(within(prompt).getByRole('button', { name: 'إلغاء' })).toHaveFocus();
    expect(prompt).toHaveTextContent('لا يُطبَّق هذا الخصم إلا بموافقة مدير مسجَّل');
    expect(prompt).toHaveTextContent('−1.50 EGP');
    expect(within(prompt).getByText('10%').tagName).toBe('BDI');
    expect(approval.listApprovers).toHaveBeenCalledWith({ action_kind: 'cart.discount.manual' });
    await approveAs(user, 'سارة عبد الحميد');

    await waitFor(() => {
      expect(add).toHaveBeenCalledOnce();
    });
    expect(approval.request).toHaveBeenCalledWith({
      action_kind: 'cart.discount.manual',
      subject_ref: 'cart-1_line-1_manual_pct_10',
      reason_code: 'promotion',
      approver_ref: 'm-1',
      pin: '135790',
    });
    expect(add).toHaveBeenCalledWith({
      cart_id: 'cart-1',
      line_id: 'line-1',
      placeholder_kind: 'manual_pct_10',
      idempotency_key: expect.any(String) as string,
      approval_id: 'appr-1',
    });
    expect(add.mock.calls[0]?.[0]).not.toHaveProperty('reason_code');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // The discounted line (D1 Discounted) and the totals (OD-3).
    const row = document.querySelector<HTMLElement>('.v5-sale-cart-line');
    expect(row).toHaveTextContent('خصم 10%');
    expect(row).toHaveTextContent('عرض ترويجي');
    expect(row).toHaveTextContent('بموافقة: سارة عبد الحميد');
    expect(row).toHaveTextContent('−1.50 EGP');
    expect(totalsRow('إجمالي الخصم')).toHaveTextContent('−1.50 EGP');
    expect(totalsRow('الإجمالي الحالي')).toHaveTextContent('13.50 EGP');
    expect(totalsRow('المجموع الفرعي')).toHaveTextContent('15.00 EGP');
    // OD-4 QtyDisabled, OD-5: no quantity change and no second discount on this line.
    const plus = screen.getByRole('button', { name: 'زيادة كمية بنادول' });
    expect(plus).toBeDisabled();
    expect(plus).toHaveAccessibleDescription('أزل الخصم لتغيير الكمية.');
    expect(discountButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حذف' })).toBeEnabled();
  });

  it('keeps a refused PIN in the prompt, cleared and focused (RT-114 C3)', async () => {
    const { user, approval, add } = await saleWithOneLine();
    approval.request.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_unavailable' });
    await fillSheet(user, '10', 'تصحيح سعر');
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    await approveAs(user, 'خالد إبراهيم');

    const prompt = screen.getByRole('dialog', { name: 'موافقة المدير' });
    expect(
      await within(prompt).findByText('لم تُقبل موافقة المدير. تحقّق من اسم المدير ورقمه السري.'),
    ).toBeInTheDocument();
    const pin = within(prompt).getByLabelText('الرقم السري للمدير');
    expect(pin).toHaveValue('');
    expect(pin).toHaveFocus();
    expect(add).not.toHaveBeenCalled();
  });

  it('shows approval_invalid from the add in the prompt, and nothing is added', async () => {
    const { user, add } = await saleWithOneLine();
    add.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_invalid' });
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    await approveAs(user, 'سارة عبد الحميد');

    const prompt = screen.getByRole('dialog', { name: 'موافقة المدير' });
    expect(
      await within(prompt).findByText(
        'انتهت الموافقة أو لا تخص هذا الخصم. اطلب الموافقة مرة أخرى.',
      ),
    ).toBeInTheDocument();
    expect(document.querySelector('.v5-discount-row')).toBeNull();
  });

  it('sends the cashier back to the sheet, draft kept, when the approval is stale', async () => {
    const { user, add } = await saleWithOneLine();
    add.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_stale' });
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    await approveAs(user, 'سارة عبد الحميد');

    const prompt = screen.getByRole('dialog', { name: 'موافقة المدير' });
    await within(prompt).findByText(
      'تغيّر الصنف منذ طلب الموافقة. راجع الخصم ثم اطلب الموافقة من جديد.',
    );
    const back = within(prompt).getByRole('button', { name: 'رجوع إلى الخصم' });
    expect(back).toHaveFocus();
    expect(within(prompt).queryByRole('button', { name: 'اعتماد الخصم' })).toBeNull();
    await user.click(back);
    expect(within(sheet()).getByRole('textbox', { name: 'قيمة الخصم' })).toHaveValue('10');
    expect(within(sheet()).getByRole('radio', { name: 'عرض ترويجي' })).toBeChecked();
  });

  it('cancels the prompt with nothing sent', async () => {
    const { user, approval, add } = await saleWithOneLine();
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    const prompt = await screen.findByRole('dialog', { name: 'موافقة المدير' });
    await user.click(within(prompt).getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(approval.request).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('says so when the terminal has no manager with a PIN, or the list cannot be read', async () => {
    const { user, approval } = await saleWithOneLine();
    approval.listApprovers.mockResolvedValueOnce({ kind: 'approvers', approvers: [] });
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    expect(await screen.findByText(/لا يوجد مدير برقم سري على هذا الجهاز/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إلغاء' }));

    approval.listApprovers.mockRejectedValueOnce(new Error('ipc'));
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    expect(
      await screen.findByText('تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'اعتماد الخصم' })).toBeDisabled();
  });

  it('keeps the prompt with the generic line when the approval call fails', async () => {
    const { user, approval } = await saleWithOneLine();
    approval.request.mockRejectedValueOnce(new Error('ipc'));
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    await approveAs(user, 'سارة عبد الحميد');
    expect(
      await screen.findByText('تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.'),
    ).toBeInTheDocument();
  });
});

describe('RT-855 manager or admin path — direct (doc 28 §4.2, D2)', () => {
  it.each<Role>(['manager', 'admin'])(
    '%s applies a fixed amount directly with the reason code, no prompt',
    async (role) => {
      const { user, approval, add } = await saleWithOneLine(role, 'سارة عبد الحميد');
      await fillSheet(user, '5', 'قرب انتهاء / عبوة تالفة', 'مبلغ ثابت');
      const form = sheet();
      expect(within(form).queryByText('يحتاج الخصم موافقة مدير قبل تطبيقه.')).toBeNull();
      expect(within(form).getByText('حتى إجمالي الصنف: 15.00 EGP.')).toBeInTheDocument();
      await user.click(within(form).getByRole('button', { name: 'تطبيق الخصم' }));

      await waitFor(() => {
        expect(add).toHaveBeenCalledWith({
          cart_id: 'cart-1',
          line_id: 'line-1',
          placeholder_kind: 'manual_amt_500',
          idempotency_key: expect.any(String) as string,
          reason_code: 'near_expiry_or_damaged',
        });
      });
      expect(add.mock.calls[0]?.[0]).not.toHaveProperty('approval_id');
      expect(approval.listApprovers).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'موافقة المدير' })).toBeNull();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      const row = document.querySelector<HTMLElement>('.v5-discount-row');
      // An amount discount reads «خصم» alone (OD-28-11).
      expect(row?.querySelector('.v5-discount-kind')).toHaveTextContent(/^خصم$/);
      expect(row).toHaveTextContent('بموافقة: سارة عبد الحميد');
      expect(totalsRow('الإجمالي الحالي')).toHaveTextContent('10.00 EGP');
    },
  );

  it('blocks an amount above the line gross in the sheet, before any call (OD-6)', async () => {
    const { user, add } = await saleWithOneLine('manager', 'سارة عبد الحميد');
    await fillSheet(user, '20', 'تصحيح سعر', 'مبلغ ثابت');
    const form = sheet();
    expect(within(form).getByRole('alert')).toHaveTextContent('المبلغ أكبر من إجمالي الصنف.');
    expect(within(form).getByRole('textbox', { name: 'قيمة الخصم' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(form).getByText('الصافي بعد الخصم').nextElementSibling).toHaveTextContent('—');
    expect(within(form).getByRole('button', { name: 'تطبيق الخصم' })).toBeDisabled();
    expect(add).not.toHaveBeenCalled();
  });

  it('shows main’s invalid_payload in the sheet with the same words', async () => {
    const { user, add } = await saleWithOneLine('manager', 'سارة عبد الحميد');
    add.mockResolvedValueOnce({ kind: 'refused', reason: 'invalid_payload' });
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'تطبيق الخصم' }));
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent(
      'المبلغ أكبر من إجمالي الصنف.',
    );
    // Editing the value clears main's refusal.
    await user.type(within(sheet()).getByRole('textbox', { name: 'قيمة الخصم' }), '{Backspace}');
    expect(within(sheet()).queryByRole('alert')).toBeNull();
  });

  it('keeps the sheet with the generic line when the add cannot be sent', async () => {
    const { user, add } = await saleWithOneLine('manager', 'سارة عبد الحميد');
    add.mockRejectedValueOnce(new Error('ipc'));
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'تطبيق الخصم' }));
    expect(
      await within(sheet()).findByText('تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.'),
    ).toBeInTheDocument();
  });

  it('accepts only a whole percent from 1 to 100, Arabic-Indic digits included', async () => {
    const { user } = await saleWithOneLine('manager', 'سارة عبد الحميد');
    await fillSheet(user, '101', 'عرض ترويجي');
    const commit = within(sheet()).getByRole('button', { name: 'تطبيق الخصم' });
    expect(commit).toBeDisabled();
    const value = within(sheet()).getByRole('textbox', { name: 'قيمة الخصم' });
    await user.clear(value);
    await user.type(value, '١٠٠');
    expect(within(sheet()).getByText('الصافي بعد الخصم').nextElementSibling).toHaveTextContent(
      '0.00 EGP',
    );
    expect(commit).toBeEnabled();
    // Switching the kind clears a value typed for the other one.
    await user.click(within(sheet()).getByRole('radio', { name: 'مبلغ ثابت' }));
    expect(value).toHaveValue('');
  });
});

describe('RT-855 refusals beside the total (D1 SecondRefused, QtyRefused)', () => {
  it('closes the flow and shows a second-discount refusal in the money column', async () => {
    const { user, add } = await saleWithOneLine('manager', 'سارة عبد الحميد');
    add.mockResolvedValueOnce({ kind: 'refused', reason: 'discount_already_applied' });
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'تطبيق الخصم' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'على هذا الصنف خصم بالفعل. أزل الخصم الحالي قبل إضافة خصم آخر.',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names line_discounted when a re-scan would merge into a discounted line', async () => {
    const { user, bridges } = await saleWithOneLine('manager', 'سارة عبد الحميد');
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'تطبيق الخصم' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    bridges.add.mockReset().mockResolvedValue({ kind: 'refused', reason: 'line_discounted' });
    await user.type(
      screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
      '6223004355218{Enter}',
    );
    await waitFor(() => {
      expect(useScanNoticeStore.getState().message).toBe(
        'لا يمكن تغيير كمية صنف عليه خصم. أزل الخصم أولًا ثم غيّر الكمية.',
      );
    });
  });

  it('removes the discount from the line (any role, D4)', async () => {
    const { user, remove } = await saleWithOneLine('manager', 'سارة عبد الحميد');
    await fillSheet(user, '10', 'عرض ترويجي');
    await user.click(within(sheet()).getByRole('button', { name: 'تطبيق الخصم' }));
    await user.click(await screen.findByRole('button', { name: 'إزالة الخصم' }));
    expect(remove).toHaveBeenCalledWith({
      cart_id: 'cart-1',
      placeholder_id: 'dp-1',
      idempotency_key: expect.any(String) as string,
    });
    await waitFor(() => {
      expect(document.querySelector('.v5-discount-row')).toBeNull();
    });
    expect(screen.queryByText('إجمالي الخصم')).toBeNull();
    expect(discountButton()).toBeEnabled();
    expect(useDiscountDetailsStore.getState().byPlaceholder).toEqual({});
  });
});

describe('RT-855 keyboard, focus and selection (OD-1)', () => {
  it('Esc closes the sheet with nothing sent, and focus returns to «خصم»', async () => {
    const { user, add } = await saleWithOneLine();
    await user.click(discountButton());
    expect(within(sheet()).getByRole('textbox', { name: 'قيمة الخصم' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(discountButton()).toHaveFocus();
    expect(add).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the sheet, and the reasons are one radio group', async () => {
    const { user } = await saleWithOneLine();
    await user.click(discountButton());
    const form = sheet();
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(form.contains(document.activeElement)).toBe(true);
    }
  });

  it('acts on the row that had focus, until the next add', async () => {
    const { user } = await saleWithOneLine();
    await addLineByScan(user);
    const rows = document.querySelectorAll<HTMLElement>('.v5-sale-cart-line');
    // The last add is selected by default.
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
    act(() => {
      rows[0]?.focus();
    });
    expect(rows[0]).toHaveAttribute('data-selected', 'true');
    expect(rows[1]).not.toHaveAttribute('data-selected');
    await user.click(discountButton());
    expect(within(sheet()).getByText('بنادول')).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('keeps «خصم» disabled while the cart has no line', () => {
    signIn('cashier', 'منى عادل');
    const bridges = makeBridges();
    render(
      <LiveSaleWorkspace
        cartBridge={bridges.cart}
        catalogueBridge={bridges.catalogue}
        approvalBridge={approvalBridge()}
        onPaymentContinue={vi.fn()}
      />,
    );
    expect(discountButton()).toBeDisabled();
  });
});

describe('RT-855 axe on the new surfaces', () => {
  it('the sheet, the prompt and the discounted cart have no violations', async () => {
    const { user } = await saleWithOneLine();
    await fillSheet(user, '10', 'عرض ترويجي');
    await expectNoAxeViolations(sheet());
    await user.click(within(sheet()).getByRole('button', { name: 'طلب موافقة المدير' }));
    const prompt = await screen.findByRole('dialog', { name: 'موافقة المدير' });
    await within(prompt).findByRole('radio', { name: 'سارة عبد الحميد' });
    await expectNoAxeViolations(prompt);
    await approveAs(user, 'سارة عبد الحميد');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const cart = document.querySelector<HTMLElement>('.v5-live-sale');
    if (cart === null) throw new Error('no sale');
    await expectNoAxeViolations(cart);
  }, 30_000); // three axe runs over the workspace: slow under a loaded coverage shard
});
