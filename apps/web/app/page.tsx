import { redirect } from 'next/navigation';

/**
 * The root sends people to the first thing they need.
 *
 * There is no server-side session here — tokens live in the browser, so the shell
 * on `/company` is what decides between the application, tenant selection and
 * sign-in. Redirecting to sign-in unconditionally would bounce an already
 * signed-in user out of their own application on every visit to `/`.
 */
export default function RootPage() {
  redirect('/company');
}
