import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFormValidation, REVEAL_FIELD_EVENT } from '../src/lib/form-validation';

let uninstall: () => void;

function mount(html: string) {
  document.body.innerHTML = html;
  return document.querySelector('form')!;
}

function submit(form: HTMLFormElement) {
  // jsdom não dispara "invalid" com requestSubmit; checkValidity dispara.
  if (form.checkValidity()) form.dispatchEvent(new Event('submit', { bubbles: true }));
}

describe('installFormValidation', () => {
  beforeEach(() => {
    document.documentElement.lang = 'pt-PT';
    uninstall = installFormValidation();
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = '';
  });

  it('marca campos obrigatórios e de email ao submeter e foca o primeiro', () => {
    const form = mount(`<form>
      <label>Nome <input name="name" required /></label>
      <label>Email <input name="email" type="email" value="x" /></label>
    </form>`);
    submit(form);
    const name = form.elements.namedItem('name') as HTMLInputElement;
    const email = form.elements.namedItem('email') as HTMLInputElement;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Campo obrigatório.',
    );
    expect(email.closest('label')?.querySelector('.kt-form-message')?.textContent).toBe(
      'Indique um email válido.',
    );
    expect(document.activeElement).toBe(name);
  });

  it('valida ao sair do campo e limpa o erro em tempo real', () => {
    const form = mount(`<form><label>Título <input name="title" minlength="5" /></label></form>`);
    const title = form.elements.namedItem('title') as HTMLInputElement;
    title.value = 'abc';
    Object.defineProperty(title, 'validity', {
      configurable: true,
      get: () => ({ valid: title.value.length >= 5, tooShort: title.value.length < 5 }),
    });
    title.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(form.querySelector('[role="alert"]')?.textContent).toBe(
      'Use pelo menos 5 caracteres (tem 3).',
    );
    title.value = 'abcdef';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    expect(title.hasAttribute('aria-invalid')).toBe(false);
    expect(title.hasAttribute('aria-describedby')).toBe(false);
    expect(form.querySelector('.kt-form-message')).toBeNull();
  });

  it('não mostra erro ao sair de um campo vazio ainda não validado', () => {
    const form = mount(`<form><label>Nome <input name="name" required /></label></form>`);
    (form.elements.namedItem('name') as HTMLInputElement).dispatchEvent(
      new FocusEvent('focusout', { bubbles: true }),
    );
    expect(form.querySelector('.kt-form-message')).toBeNull();
  });

  it('usa mensagens em inglês e ignora formulários noValidate', () => {
    document.documentElement.lang = 'en';
    const form = mount(`<form><label>Name <input name="name" required /></label></form>`);
    submit(form);
    expect(form.querySelector('.kt-form-message')?.textContent).toBe('This field is required.');

    const own = mount(`<form novalidate><label>Name <input name="name" required /></label></form>`);
    own.checkValidity();
    expect(own.querySelector('.kt-form-message')).toBeNull();
  });

  it('pede para revelar campos inválidos em painéis escondidos e usa o title no formato', () => {
    const form = mount(`<form>
      <div role="tabpanel" hidden>
        <label>Seletor <input name="selector" pattern="\\{.*\\}" title="Use { e }." value="x" /></label>
      </div>
    </form>`);
    const selector = form.elements.namedItem('selector') as HTMLInputElement;
    const revealed: EventTarget[] = [];
    form.addEventListener(REVEAL_FIELD_EVENT, (event) => {
      revealed.push(event.target!);
      (event.target as HTMLElement).closest('[role="tabpanel"]')!.removeAttribute('hidden');
    });
    submit(form);
    expect(revealed).toEqual([selector]);
    expect(form.querySelector('.kt-form-message')?.textContent).toBe('Use { e }.');
  });
});
