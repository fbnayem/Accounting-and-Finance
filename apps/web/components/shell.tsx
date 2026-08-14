'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, session } from '../lib/api';

/**
 * The application shell: navigation, the signed-in identity, and sign-out.
 *
 * The navigation is filtered by the caller's permissions, read from
 * `GET /permissions` and their own role assignments. Hiding a link is a courtesy
 * and never a control — the API refuses the call regardless, and Phase 1 exit
 * criterion 4 tests that it does. A menu that shows everything and fails on click
 * is worse for the person using it, which is the only reason this exists.
 */
const SECTIONS: { title: string; links: { href: string; label: string; permission?: string }[] }[] =
  [
    {
      title: 'Organization',
      links: [
        { href: '/company', label: 'Company setup', permission: 'organization.view' },
        { href: '/entities', label: 'Legal entities', permission: 'legal_entity.view' },
        { href: '/branches', label: 'Branches', permission: 'branch.view' },
        { href: '/settings', label: 'Accounting settings', permission: 'accounting_policy.view' },
      ],
    },
    {
      title: 'Access',
      links: [
        { href: '/users', label: 'Users', permission: 'user.view' },
        { href: '/roles', label: 'Roles', permission: 'role.view' },
        { href: '/permissions', label: 'Permissions', permission: 'role.view' },
        { href: '/sessions', label: 'Sessions', permission: 'session.view' },
      ],
    },
    {
      title: 'Finance setup',
      links: [
        {
          href: '/fiscal-calendar',
          label: 'Fiscal calendar',
          permission: 'accounting_period.view',
        },
        { href: '/currencies', label: 'Currencies', permission: 'currency.view' },
        {
          href: '/number-sequences',
          label: 'Number sequences',
          permission: 'number_sequence.view',
        },
        { href: '/tax-codes', label: 'Tax codes', permission: 'tax_code.view' },
      ],
    },
    {
      title: 'Ledger',
      links: [
        { href: '/accounts', label: 'Chart of accounts', permission: 'account.view' },
        { href: '/dimensions', label: 'Dimensions', permission: 'dimension.view' },
        { href: '/journals', label: 'Journals', permission: 'journal.view' },
        { href: '/posting-rules', label: 'Posting rules', permission: 'posting_rule.view' },
      ],
    },
    {
      title: 'Receivables',
      links: [
        { href: '/customers', label: 'Customers', permission: 'customer.view' },
        { href: '/invoices', label: 'Invoices', permission: 'invoice.view' },
        { href: '/ar-aging', label: 'AR aging', permission: 'report.view' },
      ],
    },
    {
      title: 'Payables',
      links: [
        { href: '/vendors', label: 'Vendors', permission: 'vendor.view' },
        { href: '/vendor-bills', label: 'Vendor bills', permission: 'vendor_bill.view' },
        { href: '/ap-aging', label: 'AP aging', permission: 'report.view' },
      ],
    },
    {
      title: 'Banking',
      links: [
        { href: '/bank-accounts', label: 'Bank accounts', permission: 'bank_account.view' },
        { href: '/bank-transactions', label: 'Transactions', permission: 'bank.view' },
        { href: '/bank-reconciliations', label: 'Reconciliation', permission: 'bank.reconcile' },
        { href: '/cash-position', label: 'Cash position', permission: 'bank.view' },
      ],
    },
    {
      title: 'Inventory',
      links: [
        { href: '/items', label: 'Items', permission: 'item.view' },
        { href: '/warehouses', label: 'Warehouses', permission: 'warehouse.view' },
        { href: '/inventory-documents', label: 'Stock documents', permission: 'inventory.view' },
        // Counting is the permission that makes this screen usable at all: the
        // contract has no read route for a count, so a viewer would land on a
        // page with nothing to look at.
        { href: '/stock-counts', label: 'Stock counts', permission: 'inventory.count' },
        { href: '/inventory-valuation', label: 'Valuation and GL', permission: 'inventory.view' },
      ],
    },
    {
      title: 'Fixed assets',
      links: [
        { href: '/assets', label: 'Asset register', permission: 'asset.view' },
        { href: '/depreciation', label: 'Depreciation', permission: 'asset.view' },
        {
          href: '/assets/reconciliation',
          label: 'Asset-to-GL reconciliation',
          permission: 'report.view',
        },
      ],
    },
    {
      title: 'Projects and budgets',
      links: [
        { href: '/projects', label: 'Projects', permission: 'project.view' },
        { href: '/budgets', label: 'Budgets and control', permission: 'budget.view' },
      ],
    },
    {
      title: 'Reports',
      links: [
        { href: '/trial-balance', label: 'Trial balance', permission: 'report.view' },
        { href: '/general-ledger', label: 'General ledger', permission: 'report.view' },
      ],
    },
    {
      title: 'Audit',
      links: [{ href: '/audit', label: 'Audit trail', permission: 'audit.view' }],
    },
  ];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<{ email: string; tenant: string } | null>(null);
  const [permissions, setPermissions] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!session.accessToken()) {
      router.replace('/sign-in');
      return;
    }
    void (async () => {
      try {
        const tenants = await api<{
          data: { id: string; name: string }[];
          selected_tenant_id: string | null;
        }>('/auth/tenants');
        const selected = tenants.data.find((t) => t.id === tenants.selected_tenant_id);
        if (!tenants.selected_tenant_id) {
          router.replace('/choose-tenant');
          return;
        }
        setMe({ email: '', tenant: selected?.name ?? 'Tenant' });

        // The caller's own effective permissions, derived from their roles.
        const roles = await api<{ data: { id: string; permissions: string[] }[] }>('/roles');
        const memberships = await api<{ data: { role_id: string }[] }>('/memberships');
        const mine = new Set(memberships.data.map((m) => m.role_id));
        const held = new Set<string>();
        for (const role of roles.data) {
          if (mine.has(role.id)) role.permissions.forEach((p) => held.add(p));
        }
        setPermissions(held);
      } catch {
        // A failure here means the session is gone or the tenant is unselected.
        // Either way the answer is the same, and it is not an error banner.
        session.clear();
        router.replace('/sign-in');
      }
    })();
  }, [router]);

  const signOut = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      session.clear();
      router.replace('/sign-in');
    }
  };

  return (
    <div className="shell">
      <nav className="shell-nav" aria-label="Main">
        <p className="shell-brand">Accounting Platform</p>
        {me ? <p className="shell-tenant">{me.tenant}</p> : null}
        {SECTIONS.map((section) => {
          const links = section.links.filter(
            (link) => !link.permission || !permissions || permissions.has(link.permission),
          );
          if (links.length === 0) return null;
          return (
            <div key={section.title} className="shell-section">
              <h2>{section.title}</h2>
              <ul>
                {links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      // WCAG 2.4.8: the current page is identified programmatically,
                      // not only by a different colour.
                      aria-current={pathname === link.href ? 'page' : undefined}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <div className="shell-footer">
          <button type="button" className="button button-secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </nav>
      <div className="shell-content">{children}</div>
    </div>
  );
}
