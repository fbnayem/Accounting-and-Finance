'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api, newIdempotencyKey, session } from '../../lib/api';
import { Button, ErrorBanner, Field, Notice } from '../../components/ui';

/**
 * Tenant setup — the first of doc 02's core screens, and the route F-603 added.
 *
 * One request creates the user, the tenant, the eleven system roles and the Owner
 * membership, which is what makes doc 02's acceptance criterion — "a new
 * organization reaches posting-ready status without direct DB work" — reachable.
 */
export default function SignUpPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    display_name: '',
    email: '',
    password: '',
    tenant_name: '',
    organization_name: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ access_token: string; refresh_token: string; tenant_id: string }>(
        '/auth/signup',
        {
          method: 'POST',
          body: form,
          anonymous: true,
          idempotencyKey: newIdempotencyKey('signup'),
        },
      );
      session.store(result);
      router.push('/company');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <h1>Create your account</h1>
      <ErrorBanner error={error} />
      <form onSubmit={submit} className="card">
        <Notice>
          You will be the Owner of this tenant. Ten further roles — Administrator, Accountant,
          Finance Manager, AR and AP clerk, Procurement, Treasury, Inventory Manager, Auditor and
          Viewer — are created alongside it, ready to assign to colleagues.
        </Notice>
        <Field
          label="Your name"
          name="display_name"
          value={form.display_name}
          onChange={set('display_name')}
          required
          autoComplete="name"
          error={fieldError('display_name')}
        />
        <Field
          label="Email address"
          name="email"
          type="email"
          value={form.email}
          onChange={set('email')}
          required
          autoComplete="username"
          error={fieldError('email')}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          value={form.password}
          onChange={set('password')}
          required
          autoComplete="new-password"
          hint="At least 12 characters. Length matters far more than punctuation, so a memorable phrase beats a short cryptic one."
          error={fieldError('password')}
        />
        <Field
          label="Tenant name"
          name="tenant_name"
          value={form.tenant_name}
          onChange={set('tenant_name')}
          required
          hint="Your workspace — usually the group or practice name."
          error={fieldError('tenant_name')}
        />
        <Field
          label="Organization name"
          name="organization_name"
          value={form.organization_name}
          onChange={set('organization_name')}
          required
          hint="The customer workspace inside the tenant. Legal entities live under it."
          error={fieldError('organization_name')}
        />
        <Button type="submit" variant="primary" busy={busy}>
          Create account
        </Button>
        <p className="auth-alt">
          Already have one? <Link href="/sign-in">Sign in</Link>.
        </p>
      </form>
    </div>
  );
}
