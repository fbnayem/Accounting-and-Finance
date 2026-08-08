'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, session } from '../../lib/api';
import { Button, ErrorBanner, Field, Notice } from '../../components/ui';

/**
 * Sign-in, including the two steps ADR-0005 requires: authenticate, then choose a
 * tenant. MFA sits between them when the account has a factor enrolled.
 */
export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        mfa_required: boolean;
        mfa_token?: string;
        access_token?: string;
        refresh_token?: string;
        tenant_id?: string | null;
      }>('/auth/login', { method: 'POST', body: { email, password }, anonymous: true });

      if (result.mfa_required) {
        setMfaToken(result.mfa_token ?? null);
        return;
      }
      session.store(result);
      router.push(result.tenant_id ? '/company' : '/choose-tenant');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        access_token: string;
        refresh_token: string;
        tenant_id: string | null;
      }>('/auth/mfa/verify', {
        method: 'POST',
        body: { mfa_token: mfaToken, code },
        anonymous: true,
      });
      session.store(result);
      router.push(result.tenant_id ? '/company' : '/choose-tenant');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <h1>Sign in</h1>
      <ErrorBanner error={error} />

      {mfaToken ? (
        <form onSubmit={verify} className="card">
          <Notice>
            Enter the six-digit code from your authenticator app. If you have lost the device, a
            recovery code works in its place.
          </Notice>
          <Field
            label="Authentication code"
            name="code"
            value={code}
            onChange={setCode}
            required
            autoComplete="one-time-code"
            hint="Six digits, from the app you enrolled."
          />
          <Button type="submit" variant="primary" busy={busy}>
            Verify
          </Button>
        </form>
      ) : (
        <form onSubmit={submit} className="card">
          <Field
            label="Email address"
            name="email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            autoComplete="username"
          />
          <Field
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            autoComplete="current-password"
          />
          <Button type="submit" variant="primary" busy={busy}>
            Sign in
          </Button>
          <p className="auth-alt">
            No account yet? <Link href="/sign-up">Create one</Link>.
          </p>
        </form>
      )}
    </div>
  );
}
