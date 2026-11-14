import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HealthChart,
  HealthChartRange,
  HealthChartEvent,
  HealthChartsResponse,
  HealthHeatmapResponse,
} from '@zeroops/contracts';
import { HealthChartsTab } from '../src/features/health/charts/HealthChartsTab';
import { LineChart } from '../src/features/health/charts/LineChart';
import { HealthChartCard } from '../src/features/health/charts/HealthChartCard';
import { clampZoom, panZoom, scaleZoom } from '../src/features/health/charts/chart-format';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/project-admin', () => ({
  useProjectSession: () => ({ request }),
}));

const points = (offset: number): [number, number][] =>
  Array.from({ length: 101 }, (_, index) => [index * 60, offset + (index % 10)]);

const chart: HealthChart = {
  id: 'cpu',
  title: 'CPU',
  group: 'Utilização',
  description: '',
  unit: 'percent',
  gauge: false,
  warn: null,
  crit: null,
  error: null,
  series: [
    { key: 'a', label: 'Servidor A', instance: 'a', previous: false, points: points(10) },
    { key: 'b', label: 'Servidor B', instance: 'b', previous: false, points: points(40) },
  ],
};

describe('histórico disponível nos gráficos', () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  it('abre com todo o histórico e a data real, mantendo os períodos fixos disponíveis', async () => {
    const history: HealthChartsResponse = {
      panel: 'servers',
      range: 'all',
      environment: 'production',
      source: 'prometheus',
      from: '2026-11-10T11:50:00.000Z',
      availableFrom: '2026-11-10T11:52:51.703Z',
      to: '2026-11-11T19:00:00.000Z',
      stepSeconds: 390,
      instances: [],
      charts: [{ ...chart, series: [] }],
      unavailable: null,
    };
    const heatmap: HealthHeatmapResponse = {
      metric: 'cpu',
      title: 'CPU',
      unit: 'percent',
      environment: 'production',
      instance: null,
      days: 28,
      instances: [],
      cells: Array.from({ length: 7 }, () => Array<number | null>(24).fill(null)),
      byMonthDay: Array<number | null>(31).fill(null),
      max: null,
      warn: 80,
      crit: 90,
      higherIsBetter: false,
    };
    request.mockImplementation(async (path: string) =>
      path.startsWith('/monitoring/charts/heatmap')
        ? heatmap
        : path.includes('range=24h')
          ? { ...history, range: '24h', availableFrom: undefined }
          : history,
    );
    const view = render(<HealthChartsTab />);
    await screen.findByText(/Histórico disponível desde/);
    const period = screen.getAllByLabelText<HTMLSelectElement>('Período')[0]!;
    expect(period.value).toBe('all');
    expect(view.container.querySelector('time')?.dateTime).toBe(history.availableFrom);
    expect(screen.getByText('Sem dados neste período.')).toBeTruthy();
    const compare = screen.getByRole('checkbox', {
      name: 'Comparar com o período anterior',
    });
    expect(compare).toHaveProperty('disabled', true);
    expect(request).toHaveBeenCalledWith(
      '/monitoring/charts?panel=servers&range=all&env=production',
      expect.objectContaining({ signal: expect.anything() }),
    );

    fireEvent.change(period, { target: { value: '24h' } });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/monitoring/charts?panel=servers&range=24h&env=production',
        expect.objectContaining({ signal: expect.anything() }),
      ),
    );
    expect(compare).toHaveProperty('disabled', false);
  });
});

describe('zoom dos gráficos', () => {
  it('normaliza a seleção ao período, com largura mínima e sem zoom quando cobre tudo', () => {
    expect(clampZoom(3000, 1000, 0, 6000, 120)).toEqual([1000, 3000]);
    expect(clampZoom(-50, 7000, 0, 6000, 120)).toBeNull();
    expect(clampZoom(5990, 6000, 0, 6000, 120)).toEqual([5880, 6000]);
  });

  it('afasta, aproxima e desloca sem sair do período carregado', () => {
    expect(scaleZoom([0, 6000], 0.5, 0, 6000, 120)).toEqual([1500, 4500]);
    expect(scaleZoom([0, 2000], 2, 0, 6000, 120)).toEqual([0, 4000]);
    expect(scaleZoom([1000, 4000], 4, 0, 6000, 120)).toBeNull();
    expect(panZoom([4000, 5000], 3000, 0, 6000)).toEqual([5000, 6000]);
  });
});

describe('LineChart', () => {
  afterEach(cleanup);

  const renderChart = () => {
    const view = render(
      <LineChart chart={chart} environment="production" from={0} to={6000} stepSeconds={60} />,
    );
    const svg = view.container.querySelector('svg')!;
    // viewBox 640 de largura: área útil entre x=64 e x=628.
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 220, right: 640, bottom: 220 }) as DOMRect;
    return { ...view, svg };
  };

  it('amplia o intervalo arrastado e repõe a vista completa', () => {
    const { svg } = renderChart();
    const repor = screen.getByRole('button', { name: 'Repor' });
    expect(repor).toHaveProperty('disabled', true);

    fireEvent.pointerDown(svg, { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });

    expect(repor).toHaveProperty('disabled', false);
    expect(screen.queryByText('Arraste no gráfico para ampliar um intervalo.')).toBeNull();

    fireEvent.click(repor);
    expect(repor).toHaveProperty('disabled', true);
  });

  it('mostra o valor de cada série no ponto sob o cursor e oculta séries pela legenda', () => {
    const { svg, container } = renderChart();
    fireEvent.pointerMove(svg, { clientX: 346 });
    expect(container.querySelectorAll('.health-chart-marker')).toHaveLength(2);
    expect(container.querySelector('.health-chart-tooltip')?.textContent).toContain('Servidor B');

    const legendB = screen.getByRole('button', { name: 'Servidor B' });
    fireEvent.click(legendB);
    expect(legendB.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(container.querySelector('.health-chart-tooltip')?.textContent).not.toContain(
      'Servidor B',
    );
  });
  it('desenha emails e falhas simultâneas na hora original, com filtro e detalhe acessível', () => {
    const at = new Date(3000 * 1000).toISOString();
    const base = {
      at,
      lastAt: at,
      count: 1,
      resource: null,
      planned: false,
      confirmedAt: null,
      recoveredAt: null,
      observationGap: false,
    };
    const view = render(
      <LineChart
        chart={chart}
        environment="production"
        from={0}
        to={6000}
        stepSeconds={60}
        events={[
          {
            ...base,
            id: 'e',
            kind: 'email',
            environment: 'production',
            alertContext: {
              source: 'internal',
              key: 'test_cpu_usage',
              targets: [{ chartId: 'cpu', instance: 'a' }],
            },
          },
          { ...base, id: 'd', kind: 'db2', resource: 'db2-host' },
        ]}
      />,
    );
    const lines = view.container.querySelectorAll('.health-chart-event line');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.getAttribute('x1')).toBe(lines[1]?.getAttribute('x1'));
    expect(view.container.querySelector('.health-chart-events-detail')?.textContent).toContain(
      'db2-host',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Emails enviados' }));
    expect(view.container.querySelectorAll('.health-chart-event')).toHaveLength(1);
  });

  it('não desenha emails de MySQL, CPU IBM i, outro recurso/ambiente ou origem desconhecida no CPU', () => {
    const at = new Date(3000 * 1000).toISOString();
    const base: HealthChartEvent = {
      id: 'cpu',
      kind: 'email',
      environment: 'production',
      at,
      lastAt: at,
      count: 1,
      resource: 'a',
      planned: false,
      confirmedAt: null,
      recoveredAt: null,
      observationGap: false,
      alertContext: {
        source: 'internal',
        key: 'test_cpu_usage',
        targets: [{ chartId: 'cpu', instance: 'a' }],
      },
    };
    const unrelated: HealthChartEvent[] = [
      {
        ...base,
        id: 'mysql',
        alertContext: {
          source: 'prometheus',
          key: 'MysqlIndisponivel',
          targets: [{ chartId: 'mysql_up', instance: 'a' }],
        },
      },
      {
        ...base,
        id: 'ibm',
        alertContext: {
          source: 'internal',
          key: 'test_db2_cpu',
          targets: [{ chartId: 'db2_cpu', instance: 'a' }],
        },
      },
      {
        ...base,
        id: 'resource',
        alertContext: {
          source: 'internal',
          key: 'test_cpu_usage',
          targets: [{ chartId: 'cpu', instance: 'b' }],
        },
      },
      { ...base, id: 'environment', environment: 'quality' },
      { ...base, id: 'unknown', alertContext: undefined },
      { ...base, id: 'unknown-env', environment: null },
    ];
    const view = render(
      <LineChart
        chart={chart}
        environment="production"
        instance="a"
        from={0}
        to={6000}
        stepSeconds={60}
        events={unrelated}
      />,
    );
    expect(view.container.querySelectorAll('.health-chart-event')).toHaveLength(0);
    view.rerender(
      <LineChart
        chart={chart}
        environment="production"
        instance="a"
        from={0}
        to={6000}
        stepSeconds={60}
        events={[...unrelated, base]}
      />,
    );
    expect(view.container.querySelectorAll('.health-chart-event')).toHaveLength(1);
    expect(view.container.querySelector('.health-chart-events-detail')?.textContent).not.toMatch(
      /MysqlIndisponivel|test_db2_cpu/,
    );
  });
});

describe('cartões independentes e ampliação', () => {
  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value() {
          this.setAttribute('open', '');
        },
      },
      show: {
        configurable: true,
        value() {
          this.setAttribute('open', '');
        },
      },
      close: {
        configurable: true,
        value() {
          this.removeAttribute('open');
        },
      },
    });
  });
  afterEach(() => {
    cleanup();
    request.mockReset();
  });
  const baseline: HealthChartsResponse = {
    panel: 'servers',
    range: '24h',
    environment: 'production',
    source: 'prometheus',
    from: new Date(0).toISOString(),
    to: new Date(6000 * 1000).toISOString(),
    stepSeconds: 60,
    instances: [],
    charts: [chart],
    unavailable: null,
  };
  it('usa opções curtas e ações só com ícones, mantendo nomes acessíveis e tooltips', () => {
    render(
      <HealthChartCard
        chart={chart}
        baseline={baseline}
        roles={new Map()}
        instance=""
        rangeOverride={undefined}
        onRangeChange={vi.fn()}
        compare={false}
      />,
    );
    const period = screen.getByLabelText<HTMLSelectElement>('Período deste gráfico: CPU');
    expect(Array.from(period.options, (option) => option.textContent)).toEqual([
      'Global',
      'Tudo',
      '1 h',
      '6 h',
      '24 h',
      '7 d',
      '30 d',
      '90 d',
      '395 d',
    ]);
    expect(period.title).toBe('Período global: 24 horas');
    for (const name of ['Comparar este gráfico: CPU', 'Ampliar: CPU']) {
      const button = screen.getByRole('button', { name });
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(button.getAttribute('title')).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar: CPU' }));
    const close = screen.getByRole('button', { name: 'Fechar ampliação: CPU' });
    expect(close.textContent).toBe('');
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('o ícone de comparação alterna apenas o seu cartão e indica o estado ativo', async () => {
    const memory = { ...chart, id: 'memory', title: 'Memória' };
    const data = { ...baseline, charts: [chart, memory] };
    request.mockResolvedValue({ ...baseline, charts: [chart] });
    render(
      <>
        {[chart, memory].map((item) => (
          <HealthChartCard
            key={item.id}
            chart={item}
            baseline={data}
            roles={new Map()}
            instance=""
            rangeOverride={undefined}
            onRangeChange={vi.fn()}
            compare={false}
          />
        ))}
      </>,
    );
    const compare = screen.getByRole('button', { name: 'Comparar este gráfico: CPU' });
    expect(compare.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(compare);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toBe(
      '/monitoring/charts?panel=servers&range=24h&env=production&chart=cpu&compare=1',
    );
    expect(compare.getAttribute('aria-pressed')).toBe('true');
    expect(compare.title).toBe('Desativar comparação');
    expect(
      screen
        .getByRole('button', { name: 'Comparar este gráfico: Memória' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    fireEvent.click(compare);
    expect(compare.getAttribute('aria-pressed')).toBe('false');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['all', '395d'] as const)('mantém a comparação indisponível em %s', (range) => {
    render(
      <HealthChartCard
        chart={chart}
        baseline={{ ...baseline, range }}
        roles={new Map()}
        instance=""
        rangeOverride={undefined}
        onRangeChange={vi.fn()}
        compare
      />,
    );
    const compare = screen.getByRole('button', { name: 'Comparar este gráfico: CPU' });
    expect(compare).toHaveProperty('disabled', true);
    expect(compare.getAttribute('aria-pressed')).toBe('false');
    expect(compare.title).toBe('Comparação indisponível neste período');
    fireEvent.click(compare);
    expect(request).not.toHaveBeenCalled();
  });

  it('dois cartões mantêm períodos diferentes sem consultar ou alterar o segundo', async () => {
    const memory = { ...chart, id: 'memory', title: 'Memória' };
    const data = { ...baseline, charts: [chart, memory] };
    request.mockImplementation(async () => ({ ...data, range: '6h', charts: [chart] }));
    function Pair() {
      const [range, setRange] = useState<HealthChartRange | undefined>();
      return (
        <>
          <HealthChartCard
            chart={chart}
            baseline={data}
            roles={new Map()}
            instance=""
            rangeOverride={range}
            onRangeChange={setRange}
            compare={false}
          />
          <HealthChartCard
            chart={memory}
            baseline={data}
            roles={new Map()}
            instance=""
            rangeOverride={undefined}
            onRangeChange={vi.fn()}
            compare={false}
          />
        </>
      );
    }
    render(<Pair />);
    fireEvent.change(screen.getByLabelText('Período deste gráfico: CPU'), {
      target: { value: '6h' },
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toBe(
      '/monitoring/charts?panel=servers&range=6h&env=production&chart=cpu',
    );
    expect(screen.getByLabelText('Período deste gráfico: CPU')).toHaveProperty('value', '6h');
    expect(screen.getByLabelText('Período deste gráfico: Memória')).toHaveProperty('value', '');
  });
  it('mudar um cartão consulta apenas esse gráfico; ampliar/Escape preserva séries e zoom', async () => {
    request.mockImplementation(async () => ({ ...baseline, range: '6h' }));
    const change = vi.fn();
    const view = render(
      <HealthChartCard
        chart={chart}
        baseline={baseline}
        roles={new Map()}
        instance=""
        rangeOverride="6h"
        onRangeChange={change}
        compare={false}
      />,
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/monitoring/charts?panel=servers&range=6h&env=production&chart=cpu',
        expect.objectContaining({ signal: expect.anything() }),
      ),
    );
    await waitFor(() => expect(view.container.querySelector('[hidden]')).toBeNull());
    const svg = view.container.querySelector<SVGSVGElement>('svg[role="img"]')!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 220, right: 640, bottom: 220 }) as DOMRect;
    fireEvent.click(screen.getByRole('button', { name: 'Servidor B' }));
    fireEvent.pointerDown(svg, { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    const enlarge = screen.getByRole('button', { name: 'Ampliar: CPU' });
    enlarge.focus();
    fireEvent.click(enlarge);
    expect(screen.getByRole('dialog', { name: 'CPU' })).toBeTruthy();
    expect(view.container.querySelector('svg[role="img"]')).toBe(svg);
    fireEvent(
      screen.getByRole('dialog', { name: 'CPU' }),
      new Event('cancel', { cancelable: true }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.container.querySelector('svg[role="img"]')).toBe(svg);
    expect(screen.getByRole('button', { name: 'Servidor B' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'Repor' })).toHaveProperty('disabled', false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ampliar: CPU' }));
    fireEvent.change(screen.getByLabelText('Período deste gráfico: CPU'), {
      target: { value: '' },
    });
    expect(change).toHaveBeenCalledWith(undefined);
  });
});
