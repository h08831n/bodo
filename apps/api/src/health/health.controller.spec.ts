import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let service: HealthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            checkLive: jest.fn().mockReturnValue({
              status: 'ok',
              uptime: 10,
              timestamp: '2026-11-11T00:00:00.000Z',
            }),
            checkReady: jest.fn().mockResolvedValue({
              isReady: true,
              data: {
                status: 'ok',
                uptime: 10,
                timestamp: '2026-11-11T00:00:00.000Z',
                checks: {
                  postgres: 'up',
                  redis: 'up',
                },
              },
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    service = module.get<HealthService>(HealthService);
  });

  it('should return live status', () => {
    const result = controller.getLive();
    expect(result.status).toBe('ok');
    expect(service.checkLive).toHaveBeenCalled();
  });

  it('should return 200 on ready when all services are up', async () => {
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const res = { status: statusMock } as unknown as Response;

    await controller.getReady(res);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        checks: { postgres: 'up', redis: 'up' },
      }),
    );
  });

  it('should return 503 on ready when a service is down', async () => {
    jest.spyOn(service, 'checkReady').mockResolvedValueOnce({
      isReady: false,
      data: {
        status: 'error',
        uptime: 10,
        timestamp: '2026-11-11T00:00:00.000Z',
        checks: {
          postgres: 'down',
          redis: 'up',
        },
      },
    });

    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const res = { status: statusMock } as unknown as Response;

    await controller.getReady(res);
    expect(statusMock).toHaveBeenCalledWith(503);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        checks: { postgres: 'down', redis: 'up' },
      }),
    );
  });

  it('should return 200 on ready with degraded status when worker is down', async () => {
    jest.spyOn(service, 'checkReady').mockResolvedValueOnce({
      isReady: true,
      data: {
        status: 'degraded',
        uptime: 10,
        timestamp: '2026-11-11T00:00:00.000Z',
        checks: {
          postgres: 'up',
          redis: 'up',
          worker: 'down',
        },
      },
    });

    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const res = { status: statusMock } as unknown as Response;

    await controller.getReady(res);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'degraded',
        checks: { postgres: 'up', redis: 'up', worker: 'down' },
      }),
    );
  });
});
