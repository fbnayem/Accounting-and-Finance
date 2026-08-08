import { Shell } from '../../components/shell';

/**
 * Everything inside this route group requires a session and a selected tenant.
 * The shell redirects when either is missing, so no page below has to check.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
