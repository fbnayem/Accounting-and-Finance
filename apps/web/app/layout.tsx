import type { Metadata } from 'next';
import '@acct/ui/tokens.css';
import './globals.css';
import './phase1.css';

export const metadata: Metadata = {
  title: 'Accounting Platform',
  description: 'Multi-tenant accounting and ERP platform',
};

/**
 * `lang` is not boilerplate: WCAG 2.2 criterion 3.1.1 requires the page language
 * be programmatically determinable, and a screen reader with no language reads
 * everything in its default voice. Phase 1 makes it dynamic from the user's
 * `locale` column, which F-405 added to `users` for exactly this reason.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
