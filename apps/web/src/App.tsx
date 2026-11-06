import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AdminLayout } from './admin/AdminLayout';
import { ChangePasswordPage } from './auth/ChangePasswordPage';
import { LoginPage } from './auth/LoginPage';
import { OAuthConsentPage } from './auth/OAuthConsentPage';
import { RequireAuth } from './auth/RequireAuth';
import { InboxPage } from './inbox/InboxPage';
import { SetupWizard } from './setup/SetupWizard';
import { ErrorBoundary } from '@/components/app/ErrorBoundary';
import { DesktopUpdateNotice } from '@/components/app/DesktopUpdates';
import { DevBuildBadge } from '@/components/app/DevBuildBadge';
import { extensionRoutes, useWebExtensions } from './extensions';
import { useAuth } from './auth/AuthProvider';
import { chosenChatsOnly } from './auth/chat-scope';
import { AskEzyProvider } from './askezy/AskEzyContext';
import { AskEzyPanel } from './askezy/AskEzyPanel';

/** Ask Ezy: the panel exists only for a signed-in user, on every signed-in page. */
function SignedInAskEzy() {
  const { user } = useAuth();
  if (!user || chosenChatsOnly(user)) return null;
  return (
    <ErrorBoundary>
      <AskEzyPanel />
    </ErrorBoundary>
  );
}

export function App() {
  const { pathname } = useLocation();
  const extensions = useWebExtensions();
  // A render crash shows an error panel (and is logged server-side) instead of a blank screen;
  // navigating to another route clears it.
  return (
    <ErrorBoundary resetKey={pathname}>
      <AskEzyProvider>
        <DesktopUpdateNotice />
        <DevBuildBadge />
        <SignedInAskEzy />
        <Routes>
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/change-password"
            element={
              <RequireAuth>
                <ChangePasswordPage />
              </RequireAuth>
            }
          />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<InboxPage />} />
            {/* MCP sign-in: an AI assistant app asks an admin to approve its connection. */}
            <Route path="/oauth/authorize" element={<OAuthConsentPage />} />
            <Route path="/chats/:jid" element={<InboxPage />} />
            {extensionRoutes(extensions, false)}
          </Route>
          <Route
            path="/admin/*"
            element={
              <RequireAuth admin>
                <AdminLayout />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AskEzyProvider>
    </ErrorBoundary>
  );
}

export default App;
