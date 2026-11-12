import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { getEnv } from '../../config/env.config';

@Injectable()
export class DevOnlyGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    const env = getEnv();
    if (env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    return true;
  }
}
