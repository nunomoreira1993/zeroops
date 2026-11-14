import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { HealthChartsService } from '../../../../packages/backend/src/modules/health/charts/health-charts.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Gráficos da página Saúde (tab Gráficos), só leitura para a equipa do projeto. */
@Controller('api/monitoring/charts')
export class MonitoringChartsController {
  constructor(@Inject(HealthChartsService) private readonly charts: HealthChartsService) {}

  /** `?panel=servers&range=24h&env=production&instance=<servidor>&compare=1&chart=cpu` */
  @Get()
  list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.charts.charts(req.identity, query);
  }

  /** `?metric=cpu&env=production&instance=<servidor>&days=28` */
  @Get('heatmap')
  heatmap(@Req() req: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.charts.heatmap(req.identity, query);
  }
}
