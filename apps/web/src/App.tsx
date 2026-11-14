import { useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { EmptyState, Loading } from './components/ui';
import { AuthPage } from './features/auth/AuthPage';
import { AccountPage } from './features/account/AccountPage';
import { RecoveryCodes } from './features/auth/IdentityForms';
import { InitialPasswordPage } from './features/auth/InitialPasswordPage';
import { IdentityLocaleProvider, useIdentityLocale, type SecretLink } from './lib/identity';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { IntegrationsPage } from './features/integrations/IntegrationsPage';
import { HealthPage } from './features/health/HealthPage';
import { TeamPage } from './features/team/TeamPage';
import { TicketListPage } from './features/tickets/TicketListPage';
import { NewTicketPage } from './features/tickets/NewTicketPage';
import { TicketDetailPage } from './features/tickets/TicketDetailPage';
import { InstanceProjectsPage } from './features/projects/InstanceProjectsPage';
import { ProjectAdminPage, parseProjectAdminRoute } from './features/projects/ProjectAdminPage';
import { FlowsPage, parseFlowsRoute } from './features/flows/FlowsPage';
import { installFormValidation } from './lib/form-validation';
import { useRoute } from './lib/hooks';
import { SessionProvider, useSession } from './lib/session';

function Portal({ initialLink }: { initialLink: SecretLink | null }) {
  const { session, loading, challenge, recoveryCodes, dismissRecoveryCodes } = useSession();
  const { setLocale } = useIdentityLocale();
  const route = useRoute();
  const [link, setLink] = useState(initialLink);
  useEffect(() => {
    if (session?.user.locale === 'en' || session?.user.locale === 'pt-PT')
      setLocale(session.user.locale);
  }, [session?.user.locale, setLocale]);
  useEffect(() => {
    document.title = session ? 'Workspace Pizza Hut · ZeroOps' : 'Iniciar sessão · ZeroOps';
  }, [session]);
  if (loading)
    return (
      <div className="boot-screen">
        <Loading label="A preparar o workspace…" />
      </div>
    );
  if (!session || link || challenge)
    return <AuthPage link={link} onConsumed={() => setLink(null)} />;
  if (recoveryCodes)
    return (
      <main className="recovery-page">
        <RecoveryCodes codes={recoveryCodes} onDone={dismissRecoveryCodes} />
      </main>
    );
  if (session.user.passwordChangeRequired) return <InitialPasswordPage />;

  let page;
  if (route === 'dashboard') page = <DashboardPage />;
  else if (route === 'tickets') page = <TicketListPage />;
  else if (route === 'tickets/new') page = <NewTicketPage />;
  else if (/^tickets\/[^/]+$/.test(route)) {
    page = <TicketDetailPage key={route} id={route.slice('tickets/'.length)} />;
  } else if (route === 'integrations') page = <IntegrationsPage />;
  else if ((route === 'health' || route.startsWith('health/')) && session.user.role !== 'client')
    page = <HealthPage />;
  else if (route === 'team' && (session.user.role === 'admin' || session.user.instanceAdmin))
    page = <TeamPage />;
  else if (route === 'instance-projects' && session.user.instanceAdmin)
    page = <InstanceProjectsPage />;
  else if (
    /^projects\/[^/]+(?:\/[^/]+){0,2}$/.test(route) &&
    (session.user.role === 'admin' || session.user.instanceAdmin)
  ) {
    const detail = parseProjectAdminRoute(route);
    page = <ProjectAdminPage id={detail.id} tab={detail.tab} sub={detail.sub} />;
  } else if (
    /^flows(?:\/[^/]+)?$/.test(route) &&
    (session.user.role === 'admin' || session.user.instanceAdmin)
  ) {
    const flowId = parseFlowsRoute(route);
    page = <FlowsPage key={flowId ?? 'list'} projectId={session.user.projectId} flowId={flowId} />;
  } else if (route === 'account') page = <AccountPage />;
  else
    page = (
      <EmptyState
        title="Página indisponível"
        action={
          <a className="button button-primary" href="#dashboard">
            Voltar à visão geral
          </a>
        }
      >
        Esta página não existe ou não está disponível para o seu perfil.
      </EmptyState>
    );
  return <Shell route={route}>{page}</Shell>;
}

export function App({ initialLink = null }: { initialLink?: SecretLink | null }) {
  useEffect(() => installFormValidation(), []);
  return (
    <IdentityLocaleProvider>
      <SessionProvider>
        <Portal initialLink={initialLink} />
      </SessionProvider>
    </IdentityLocaleProvider>
  );
}
