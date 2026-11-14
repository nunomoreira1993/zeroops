import type { MailSection } from '../smtp/mail-layout.js';

export type InviteRole = 'client' | 'technical' | 'qa' | 'release' | 'admin';

/** Dados do convite lidos da BD no momento do envio (não ficam no payload cifrado). */
export interface InviteMailDetails {
  displayName: string;
  role: InviteRole;
  organization: 'client' | 'deloitte' | null;
  projectName: string;
  invitedBy: string;
  /** O email já tem conta no ZeroOps: entra com a palavra-passe atual. */
  existingAccount?: boolean;
}

/** Configuração de acesso de rede que cada utilizador tem de fazer na sua máquina. */
export interface IdentityMailAccess {
  /** IP para a entrada `hosts` quando o domínio do portal não tem DNS público. */
  hostsIp?: string;
  /** Certificado (PEM) da CA privada que emitiu o certificado HTTPS do portal. */
  caCertificatePem?: string;
}

type Locale = 'pt-PT' | 'en';

export const CA_ATTACHMENT_NAME = 'zeroops-ca.crt';

const roleLabels: Record<Locale, Record<InviteRole, string>> = {
  'pt-PT': {
    client: 'Cliente',
    technical: 'Técnico',
    qa: 'Qualidade (QA)',
    release: 'Release',
    admin: 'Administrador',
  },
  en: {
    client: 'Client',
    technical: 'Technical',
    qa: 'Quality (QA)',
    release: 'Release',
    admin: 'Administrator',
  },
};

const roleTasks: Record<Locale, Record<InviteRole, string[]>> = {
  'pt-PT': {
    client: [
      'Abrir pedidos (tickets) com a descrição do problema, prioridade e anexos.',
      'Acompanhar o estado dos seus pedidos e responder às perguntas da equipa de suporte.',
      'Receber por email as respostas e as atualizações dos seus pedidos.',
    ],
    technical: [
      'Analisar e resolver tickets, com investigação assistida pelo Copilot sobre os dados de Produção (só leitura).',
      'Trocar notas internas com a equipa e rever as respostas propostas antes de as enviar ao cliente.',
      'Consultar a Saúde da plataforma e os alertas.',
    ],
    qa: [
      'Validar em Qualidade as correções dos tickets e registar o resultado dos testes.',
      'Trocar notas internas com a equipa e consultar o histórico dos tickets.',
    ],
    release: [
      'Preparar e acompanhar a passagem a Produção das correções aprovadas.',
      'Consultar o estado dos tickets, as validações de QA e a Saúde da plataforma.',
    ],
    admin: [
      'Gerir a equipa: convidar utilizadores, alterar perfis e desativar acessos.',
      'Configurar as Integrações (SMTP, Copilot, conectores) e os alertas de Saúde.',
      'Todas as tarefas dos perfis técnicos sobre os tickets.',
    ],
  },
  en: {
    client: [
      'Open tickets with the problem description, priority and attachments.',
      'Follow the status of your tickets and answer the support team questions.',
      'Receive replies and updates about your tickets by email.',
    ],
    technical: [
      'Analyse and solve tickets, with Copilot-assisted investigation on Production data (read-only).',
      'Exchange internal notes with the team and review proposed replies before sending them to the client.',
      'Check platform Health and alerts.',
    ],
    qa: [
      'Validate ticket fixes in Quality and record the test results.',
      'Exchange internal notes with the team and check the ticket history.',
    ],
    release: [
      'Prepare and follow the Production rollout of approved fixes.',
      'Check ticket status, QA validations and platform Health.',
    ],
    admin: [
      'Manage the team: invite users, change roles and disable access.',
      'Configure Integrations (SMTP, Copilot, connectors) and Health alerts.',
      'All technical tasks on tickets.',
    ],
  },
};

/** Perfis que, por omissão, têm de configurar MFA na ativação (igual a `requiresMfa`). */
export const inviteRequiresMfa = (role: InviteRole) => role !== 'client';

interface InviteContentInput {
  locale: Locale;
  recipient: string;
  publicUrl: string;
  details?: InviteMailDetails;
  access?: IdentityMailAccess;
  validUntil?: string;
  /** Palavra-passe temporária de uma conta nova (troca obrigatória no primeiro acesso). */
  temporaryPassword?: string;
}

/** Como o convidado entra: palavra-passe temporária, conta existente ou ligação de ativação. */
export type InviteAccessMode = 'temporary' | 'existing' | 'link';

export const inviteAccessMode = (
  temporaryPassword: string | undefined,
  details: InviteMailDetails | undefined,
): InviteAccessMode =>
  temporaryPassword ? 'temporary' : details?.existingAccount ? 'existing' : 'link';

/** Monta o texto do convite: dados da conta, preparação da máquina, ativação e utilização. */
export function inviteMailContent(input: InviteContentInput) {
  const en = input.locale === 'en';
  const host = new URL(input.publicUrl).hostname;
  const loginUrl = new URL('/login', input.publicUrl).href;
  const details = input.details;
  const role = details?.role;
  const mfa = role ? inviteRequiresMfa(role) : true;
  const hostsIp = input.access?.hostsIp;
  const hostsLine = hostsIp ? `${hostsIp} ${host}` : undefined;
  const hasCa = Boolean(input.access?.caCertificatePem);
  const mode = inviteAccessMode(input.temporaryPassword, details);
  let step = 0;
  const next = () => ++step;

  const greeting = details
    ? en
      ? `Hello ${details.displayName}, ${details.invitedBy} invited you to ZeroOps, the ticket and support platform for the ${details.projectName} project.`
      : `Olá ${details.displayName}, ${details.invitedBy} convidou-o para o ZeroOps, a plataforma de tickets e suporte do projeto ${details.projectName}.`
    : en
      ? 'You have been invited to ZeroOps, the ticket and support platform.'
      : 'Foi convidado para o ZeroOps, a plataforma de tickets e suporte.';
  const order =
    hostsLine || hasCa
      ? en
        ? `Follow the steps below in order. The computer setup (steps 1 and 2) is done only once; only then ${mode === 'link' ? 'activate the account' : 'sign in'}.`
        : `Siga os passos abaixo pela ordem indicada. A preparação do computador (passos 1 e 2) é feita apenas uma vez; só depois ${mode === 'link' ? 'ative a conta' : 'entre no ZeroOps'}.`
      : en
        ? `Follow the steps below to ${mode === 'link' ? 'activate your account' : 'sign in'}.`
        : `Siga os passos abaixo para ${mode === 'link' ? 'ativar a sua conta' : 'entrar no ZeroOps'}.`;

  const facts: [string, string][] = [[en ? 'Account (email)' : 'Conta (email)', input.recipient]];
  if (mode === 'temporary')
    facts.push([en ? 'Temporary password' : 'Palavra-passe temporária', input.temporaryPassword!]);
  if (details) {
    facts.push([en ? 'Name' : 'Nome', details.displayName]);
    facts.push([en ? 'Project' : 'Projeto', details.projectName]);
    facts.push([en ? 'Role' : 'Perfil', roleLabels[input.locale][details.role]]);
    if (details.organization)
      facts.push([
        en ? 'Organization' : 'Organização',
        details.organization === 'deloitte' ? 'Deloitte' : en ? 'Client' : 'Cliente',
      ]);
    facts.push([en ? 'Invited by' : 'Convidado por', details.invitedBy]);
  }
  facts.push([en ? 'Sign-in address' : 'Endereço de entrada', loginUrl]);

  const sections: MailSection[] = [];
  const before = [
    hostsIp
      ? en
        ? `Be connected to the Ibersol network or VPN with access to the server ${hostsIp}. To check, run in PowerShell: Test-NetConnection ${hostsIp} -Port 443 (it must show TcpTestSucceeded : True).`
        : `Estar ligado à rede ou VPN da Ibersol com acesso ao servidor ${hostsIp}. Para confirmar, no PowerShell: Test-NetConnection ${hostsIp} -Port 443 (deve mostrar TcpTestSucceeded : True).`
      : undefined,
    hostsLine || hasCa
      ? en
        ? 'Administrator rights on your computer for steps 1 and 2. If you do not have them, forward this email to your IT support.'
        : 'Permissões de administrador no computador para os passos 1 e 2. Se não as tiver, reencaminhe este email para o seu suporte informático.'
      : undefined,
    mfa
      ? en
        ? 'An authenticator app on your phone (Microsoft Authenticator, Google Authenticator or another TOTP app). Multifactor authentication is mandatory for your role.'
        : 'Uma aplicação autenticadora no telemóvel (Microsoft Authenticator, Google Authenticator ou outra compatível com TOTP). A autenticação multifator é obrigatória para o seu perfil.'
      : undefined,
  ].filter((item): item is string => Boolean(item));
  if (before.length)
    sections.push({ title: en ? 'Before you start' : 'Antes de começar', items: before });

  if (hostsLine)
    sections.push({
      title: en
        ? `Step ${next()}: point ${host} to the server (once)`
        : `Passo ${next()}: apontar ${host} para o servidor (só uma vez)`,
      items: en
        ? [
            `The address ${host} has no public DNS, so your computer needs an entry in the hosts file.`,
            'Windows: open Notepad as administrator (right click > Run as administrator), File > Open, C:\\Windows\\System32\\drivers\\etc\\hosts (choose "All files" in the type filter).',
            `Add this line at the end and save: ${hostsLine}`,
            `If a line with ${host} already exists, replace it instead of adding another one.`,
            `macOS/Linux: sudo sh -c 'echo "${hostsLine}" >> /etc/hosts'`,
          ]
        : [
            `O endereço ${host} não tem DNS público, por isso o computador precisa de uma entrada no ficheiro hosts.`,
            'Windows: abra o Bloco de Notas como administrador (botão direito > Executar como administrador), Ficheiro > Abrir, C:\\Windows\\System32\\drivers\\etc\\hosts (escolha «Todos os ficheiros» no filtro do tipo).',
            `Acrescente esta linha no fim e guarde: ${hostsLine}`,
            `Se já existir uma linha com ${host}, substitua-a em vez de acrescentar outra.`,
            `macOS/Linux: sudo sh -c 'echo "${hostsLine}" >> /etc/hosts'`,
          ],
    });

  if (hasCa)
    sections.push({
      title: en
        ? `Step ${next()}: trust the security certificate (once)`
        : `Passo ${next()}: confiar no certificado de segurança (só uma vez)`,
      items: en
        ? [
            `The file ${CA_ATTACHMENT_NAME} is attached to this email. Save it, for example in Downloads. It is only valid for ${host} and cannot be used for any other site.`,
            'Windows (Edge/Chrome): double click the file > Install Certificate > Local Machine > "Place all certificates in the following store" > Trusted Root Certification Authorities > Finish.',
            `Windows alternative, in PowerShell as administrator: Import-Certificate -FilePath "$env:USERPROFILE\\Downloads\\${CA_ATTACHMENT_NAME}" -CertStoreLocation Cert:\\LocalMachine\\Root`,
            'Firefox uses its own store: Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import, and tick "Trust this CA to identify websites".',
            'macOS: open the file in Keychain Access, add it to the System keychain and set "Always Trust".',
            `Close and reopen the browser and open ${loginUrl} to confirm that the sign-in page appears without a security warning.`,
          ]
        : [
            `O ficheiro ${CA_ATTACHMENT_NAME} segue em anexo neste email. Guarde-o, por exemplo, em Transferências. Só é válido para ${host} e não pode ser usado para outros sites.`,
            'Windows (Edge/Chrome): duplo clique no ficheiro > Instalar certificado > Máquina local > «Colocar todos os certificados no arquivo seguinte» > Autoridades de Certificação de Raiz Fidedignas > Concluir.',
            `Alternativa no Windows, no PowerShell como administrador: Import-Certificate -FilePath "$env:USERPROFILE\\Downloads\\${CA_ATTACHMENT_NAME}" -CertStoreLocation Cert:\\LocalMachine\\Root`,
            'O Firefox usa um arquivo próprio: Definições > Privacidade e segurança > Certificados > Ver certificados > Autoridades > Importar, e marque «Confiar nesta CA para identificar websites».',
            'macOS: abra o ficheiro no Acesso a Chaves, adicione-o ao porta-chaves Sistema e escolha «Confiar sempre».',
            `Feche e volte a abrir o browser e abra ${loginUrl} para confirmar que a página de entrada aparece sem aviso de segurança.`,
          ],
    });

  const mfaItems = mfa
    ? en
      ? [
          'Set up multifactor authentication: scan the QR code with the authenticator app and enter the 6-digit code.',
          'Save the recovery codes shown at the end in a safe place. They are shown only once and let you sign in if you lose your phone.',
        ]
      : [
          'Configure a autenticação multifator: leia o código QR com a aplicação autenticadora e introduza o código de 6 dígitos.',
          'Guarde num local seguro os códigos de recuperação apresentados no fim. Só aparecem uma vez e permitem entrar se perder o telemóvel.',
        ]
    : [];
  const validity = input.validUntil
    ? en
      ? `; the invitation is valid until ${input.validUntil}`
      : `; o convite é válido até ${input.validUntil}`
    : '';
  const activation =
    mode === 'temporary'
      ? en
        ? [
            `Open ${loginUrl} (or click the "Sign in to ZeroOps" button below)${validity}.`,
            'Sign in with your email and the temporary password shown above (copy it exactly, including the dashes).',
            ...mfaItems,
            'Then choose your own password, with at least 12 characters. The temporary password stops working after that.',
          ]
        : [
            `Abra ${loginUrl} (ou clique no botão «Entrar no ZeroOps» abaixo)${validity}.`,
            'Entre com o seu email e a palavra-passe temporária indicada acima (copie-a exatamente, incluindo os hífenes).',
            ...mfaItems,
            'Depois escolha a sua palavra-passe, com pelo menos 12 caracteres. A temporária deixa de funcionar a seguir.',
          ]
      : mode === 'existing'
        ? en
          ? [
              `You already have a ZeroOps account with this email. Sign in at ${loginUrl} with your current password${validity}.`,
              `After signing in, the ${details?.projectName ?? 'new'} project becomes available in the project selector.`,
            ]
          : [
              `Já tem conta no ZeroOps com este email. Entre em ${loginUrl} com a sua palavra-passe atual${validity}.`,
              `Depois de entrar, o projeto ${details?.projectName ?? 'novo'} fica disponível no seletor de projetos.`,
            ]
        : en
          ? [
              `Click the "Activate account" button below${input.validUntil ? `; the single-use link is valid until ${input.validUntil}` : ''}.`,
              'Confirm your name and choose a password with at least 12 characters.',
              ...mfaItems,
            ]
          : [
              `Clique no botão «Ativar conta» abaixo${input.validUntil ? `; a ligação é de uso único e válida até ${input.validUntil}` : ''}.`,
              'Confirme o seu nome e escolha uma palavra-passe com pelo menos 12 caracteres.',
              ...mfaItems,
            ];
  sections.push({
    title:
      mode === 'link'
        ? en
          ? `Step ${next()}: activate your account`
          : `Passo ${next()}: ativar a conta`
        : en
          ? `Step ${next()}: first sign-in`
          : `Passo ${next()}: primeiro acesso`,
    items: activation,
  });

  sections.push({
    title: en ? `Step ${next()}: everyday use` : `Passo ${next()}: utilização diária`,
    items: en
      ? [
          `Sign in at ${loginUrl} (add it to your favourites).`,
          mfa
            ? 'Use your email, password and the code from the authenticator app.'
            : 'Use your email and password.',
          'Forgot your password? Use "Forgot your password?" on the sign-in page.',
        ]
      : [
          `Entre em ${loginUrl} (guarde nos favoritos).`,
          mfa
            ? 'Use o seu email, a palavra-passe e o código da aplicação autenticadora.'
            : 'Use o seu email e a palavra-passe.',
          'Esqueceu-se da palavra-passe? Use «Esqueceu-se da palavra-passe?» na página de entrada.',
        ],
  });

  if (role)
    sections.push({
      title: en
        ? `What you can do as ${roleLabels.en[role]}`
        : `O que pode fazer com o perfil ${roleLabels['pt-PT'][role]}`,
      items: roleTasks[input.locale][role],
    });

  const contact = details?.invitedBy ?? (en ? 'your administrator' : 'o administrador');
  sections.push({
    title: en ? 'Common problems' : 'Problemas frequentes',
    items: [
      ...(hostsLine
        ? [
            en
              ? `"This site can't be reached" or DNS error: check step 1 and the VPN, then run ipconfig /flushdns.`
              : '«Não é possível aceder a este site» ou erro de DNS: verifique o passo 1 e a VPN e corra ipconfig /flushdns.',
          ]
        : []),
      ...(hasCa
        ? [
            en
              ? '"Your connection is not private" (NET::ERR_CERT_AUTHORITY_INVALID): check step 2 and restart the browser.'
              : '«A sua ligação não é privada» (NET::ERR_CERT_AUTHORITY_INVALID): verifique o passo 2 e reinicie o browser.',
          ]
        : []),
      mode === 'link'
        ? en
          ? `Expired or already used link: ask ${contact} for a new invitation.`
          : `Ligação expirada ou já utilizada: peça um novo convite a ${contact}.`
        : mode === 'existing'
          ? en
            ? `The project does not appear after signing in (the invitation expires after 48 hours): ask ${contact} to resend it.`
            : `O projeto não aparece depois de entrar (o convite expira ao fim de 48 horas): peça a ${contact} que o reenvie.`
          : en
            ? `The temporary password or the invitation stopped working (expired after 48 hours): ask ${contact} to resend the invitation.`
            : `A palavra-passe temporária ou o convite deixaram de funcionar (expiram ao fim de 48 horas): peça a ${contact} que reenvie o convite.`,
    ],
  });

  return { greeting, order, facts, sections };
}
