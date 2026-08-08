'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, newIdempotencyKey, session } from '../../lib/api';
import { Button, ErrorBanner, Field, Notice } from '../../components/ui';

/**
 * The accept half of doc 02's invite/accept flow — the route F-604 added, because
 * `POST /users/invite` shipped with nothing able to redeem what it produced.
 */
function AcceptInvitationForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ access_token: string; refresh_token: string; tenant_id: string }>(
        '/auth/invitations/accept',
        {
          method: 'POST',
          anonymous: true,
          idempotencyKey: newIdempotencyKey('accept'),
          body: {
            token,
            display_name: displayName || undefined,
            password: password || undefined,
          },
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
      <h1>Accept your invitation</h1>
      <ErrorBanner error={error} />
      <form onSubmit={submit} className="card">
        <Notice>
          If you already have an account, leave the name and password blank — ADR-0005 gives one
          person one identity, so your existing account is attached to this tenant rather than
          duplicated.
        </Notice>
        <Field label="Invitation token" name="token" value={token} onChange={setToken} required />
        <Field
          label="Your name"
          name="display_name"
          value={displayName}
          onChange={setDisplayName}
          hint="New accounts only."
        />
        <Field
          label="Password"
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="New accounts only. At least 12 characters."
        />
        <Button type="submit" variant="primary" busy={busy}>
          Accept invitation
        </Button>
      </form>
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <AcceptInvitationForm />
    </Suspense>
  );
}
