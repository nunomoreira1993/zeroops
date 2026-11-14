type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const touched = new WeakSet<Field>();
let sequence = 0;

function isField(target: EventTarget | null): target is Field {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

/**
 * Evento emitido (com bubbling) antes de focar um campo inválido escondido,
 * para que separadores/painéis o possam mostrar.
 */
export const REVEAL_FIELD_EVENT = 'kt-reveal-field';

// Formulários com noValidate têm validação própria e ficam de fora.
function managedField(target: EventTarget | null): Field | null {
  if (!isField(target) || !target.form || target.form.noValidate) return null;
  if (target instanceof HTMLInputElement && ['hidden', 'submit', 'button'].includes(target.type))
    return null;
  return target.willValidate ? target : null;
}

function english() {
  return document.documentElement.lang.toLowerCase().startsWith('en');
}

export function validationMessage(field: Field): string {
  const validity = field.validity;
  const en = english();
  const t = (pt: string, enText: string) => (en ? enText : pt);
  if (validity.valueMissing) {
    if (field instanceof HTMLInputElement && field.type === 'checkbox')
      return t('Confirme esta opção para continuar.', 'Confirm this option to continue.');
    if (field instanceof HTMLSelectElement) return t('Selecione uma opção.', 'Select an option.');
    return t('Campo obrigatório.', 'This field is required.');
  }
  if (validity.typeMismatch) {
    if (field.type === 'email') return t('Indique um email válido.', 'Enter a valid email.');
    if (field.type === 'url') return t('Indique um URL válido.', 'Enter a valid URL.');
  }
  if (validity.tooShort && 'minLength' in field)
    return t(
      `Use pelo menos ${field.minLength} caracteres (tem ${field.value.length}).`,
      `Use at least ${field.minLength} characters (currently ${field.value.length}).`,
    );
  if (validity.tooLong && 'maxLength' in field)
    return t(
      `Use no máximo ${field.maxLength} caracteres.`,
      `Use at most ${field.maxLength} characters.`,
    );
  if (field instanceof HTMLInputElement) {
    if (validity.rangeUnderflow)
      return t(`O valor mínimo é ${field.min}.`, `The minimum value is ${field.min}.`);
    if (validity.rangeOverflow)
      return t(`O valor máximo é ${field.max}.`, `The maximum value is ${field.max}.`);
    if (validity.stepMismatch)
      return field.step === '1'
        ? t('Use um número inteiro.', 'Use a whole number.')
        : t(`Use múltiplos de ${field.step}.`, `Use multiples of ${field.step}.`);
    if (validity.badInput) return t('Indique um número válido.', 'Enter a valid number.');
    if (validity.patternMismatch) return field.title || t('Formato inválido.', 'Invalid format.');
  }
  if (validity.customError) return field.validationMessage;
  return t('Valor inválido.', 'Invalid value.');
}

function placeMessage(field: Field, message: HTMLElement) {
  const label = field.closest('label');
  const isChoice =
    field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio');
  if (label && !isChoice) label.append(message);
  else (label ?? field.closest('.markdown-editor') ?? field).after(message);
}

function describedBy(field: Field, id: string, add: boolean) {
  const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const next = add ? [...new Set([...ids, id])] : ids.filter((value) => value !== id);
  if (next.length) field.setAttribute('aria-describedby', next.join(' '));
  else field.removeAttribute('aria-describedby');
}

function messageFor(field: Field) {
  const id = field.dataset.ktMessage;
  return id ? document.getElementById(id) : null;
}

export function clearFieldError(field: Field) {
  const message = messageFor(field);
  if (message) {
    describedBy(field, message.id, false);
    message.remove();
  }
  delete field.dataset.ktMessage;
  field.removeAttribute('aria-invalid');
}

export function updateFieldError(field: Field) {
  if (field.validity.valid) {
    clearFieldError(field);
    return true;
  }
  let message = messageFor(field);
  if (!message) {
    message = document.createElement('span');
    message.id = `kt-form-message-${++sequence}`;
    message.className = 'kt-form-message';
    message.setAttribute('role', 'alert');
    field.dataset.ktMessage = message.id;
    placeMessage(field, message);
    describedBy(field, message.id, true);
  }
  message.textContent = validationMessage(field);
  field.setAttribute('aria-invalid', 'true');
  return false;
}

function clearForm(form: HTMLFormElement) {
  delete form.dataset.ktValidated;
  for (const element of Array.from(form.elements)) {
    if (isField(element)) {
      touched.delete(element);
      clearFieldError(element);
    }
  }
}

/**
 * Substitui os balões nativos do browser por mensagens no estilo KTUI
 * (aria-invalid + .kt-form-message). A submissão continua bloqueada pela
 * validação nativa; os erros aparecem ao submeter, ao sair do campo e em
 * tempo real a partir daí.
 */
export function installFormValidation(root: Document | HTMLElement = document) {
  let focusPending = false;
  const onInvalid = (event: Event) => {
    const field = managedField(event.target);
    if (!field) return;
    event.preventDefault();
    field.form!.dataset.ktValidated = 'true';
    updateFieldError(field);
    if (!focusPending) {
      focusPending = true;
      if (field.closest('[hidden]'))
        field.dispatchEvent(new CustomEvent(REVEAL_FIELD_EVENT, { bubbles: true }));
      field.focus();
      // Se o painel só fica visível depois do render, volta a focar.
      setTimeout(() => {
        if (document.activeElement !== field) field.focus();
        focusPending = false;
      });
    }
  };
  const onBlur = (event: Event) => {
    const field = managedField(event.target);
    if (!field) return;
    if (field.value !== '' || field.form!.dataset.ktValidated || touched.has(field)) {
      touched.add(field);
      updateFieldError(field);
    }
  };
  const onInput = (event: Event) => {
    const field = managedField(event.target);
    if (!field) return;
    if (touched.has(field) || field.form!.dataset.ktValidated || field.dataset.ktMessage)
      updateFieldError(field);
  };
  const onSubmit = (event: Event) => {
    if (event.target instanceof HTMLFormElement && !event.target.noValidate)
      queueMicrotask(() => clearForm(event.target as HTMLFormElement));
  };
  const onReset = (event: Event) => {
    if (event.target instanceof HTMLFormElement) clearForm(event.target);
  };
  root.addEventListener('invalid', onInvalid, true);
  root.addEventListener('focusout', onBlur, true);
  root.addEventListener('input', onInput, true);
  root.addEventListener('change', onInput, true);
  root.addEventListener('submit', onSubmit, true);
  root.addEventListener('reset', onReset, true);
  return () => {
    root.removeEventListener('invalid', onInvalid, true);
    root.removeEventListener('focusout', onBlur, true);
    root.removeEventListener('input', onInput, true);
    root.removeEventListener('change', onInput, true);
    root.removeEventListener('submit', onSubmit, true);
    root.removeEventListener('reset', onReset, true);
  };
}
